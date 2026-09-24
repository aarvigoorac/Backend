require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

// ==========================================
// 1. FIREBASE ADMIN INITIALIZATION
// ==========================================
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  })
});

const db = admin.firestore();
const app = express();

// Middleware
app.use(cors({ origin: true })); 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 2. SECURITY & RATE LIMITING
// ==========================================
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 30, 
  message: { error: "Too many requests. Please wait a minute and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

async function verifyAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    if (!userDoc.exists || userDoc.data().admin !== true) {
      return res.status(403).json({ error: 'Forbidden: Admin privileges required' });
    }
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// ==========================================
// 3. ZOHO TOKEN MANAGEMENT
// ==========================================
let cachedZohoToken = null;
let tokenExpiryTime = 0;

async function getZohoAccessToken() {
  if (cachedZohoToken && Date.now() < tokenExpiryTime) {
    return cachedZohoToken;
  }
  try {
    const url = `https://accounts.zoho.in/oauth/v2/token?refresh_token=${process.env.ZOHO_REFRESH_TOKEN}&client_id=${process.env.ZOHO_CLIENT_ID}&client_secret=${process.env.ZOHO_CLIENT_SECRET}&grant_type=refresh_token`;
    const response = await axios.post(url);
    
    cachedZohoToken = response.data.access_token;
    tokenExpiryTime = Date.now() + (response.data.expires_in * 1000) - 60000;
    
    return cachedZohoToken;
  } catch (error) {
    console.error("Error fetching Zoho Token:", error.response?.data || error.message);
    throw new Error("Failed to authenticate with Zoho ERP.");
  }
}

// ==========================================
// 4. HELPER: FIREBASE KEYWORD GENERATOR
// ==========================================
function generateSearchKeywords(name = '', brand = '', category = '', sku = '') {
  const keywords = {};
  const combinedText = `${name} ${brand} ${category} ${sku}`.toLowerCase();
  const cleanedText = combinedText.replace(/[\.\#\$\[\]\/]/g, ' ');
  const words = cleanedText.split(/\s+/).filter(w => w.length > 0);

  words.forEach(word => {
    for (let i = 2; i <= word.length; i++) {
      keywords[word.substring(0, i)] = true;
    }
  });
  return keywords;
}

// ==========================================
// 5. ROUTES: ZOHO -> FIREBASE (WEBHOOKS)
// ==========================================
app.post('/webhook/zoho-item-sync', async (req, res) => {
  try {
    const payload = req.body.JSONString ? JSON.parse(req.body.JSONString) : req.body;
    const item = payload.item; 

    if (!item || !item.item_id) {
      return res.status(400).json({ error: "Invalid payload format" });
    }

    const itemRef = db.collection('products').doc(item.item_id);
    const existingDoc = await itemRef.get();

    const updateData = {
      name: item.name,
      description: item.description || "",
      sku: item.sku || "",
      price: Number(item.rate) || 0,
      stock: Number(item.stock_on_hand) || 0,
      category: item.category_name || "General",
      brand: item.brand || "",
      isActive: item.status === "active",
      updatedAt: new Date().toISOString()
    };

    const isNew = !existingDoc.exists;
    const nameChanged = existingDoc.exists && existingDoc.data().name !== item.name;
    
    if (isNew || nameChanged) {
      updateData.searchKeywords = generateSearchKeywords(item.name, item.brand, item.category_name, item.sku);
    }

    await itemRef.set(updateData, { merge: true });
    res.status(200).json({ success: true, message: `Item ${item.item_id} synced.` });
  } catch (error) {
    console.error("Webhook Sync Error:", error);
    res.status(500).json({ error: "Internal Server Error during sync" });
  }
});

app.post('/webhook/zoho-invoice-sync', async (req, res) => {
  try {
    const payload = req.body.JSONString ? JSON.parse(req.body.JSONString) : req.body;
    const invoice = payload.invoice;

    if (!invoice || !invoice.line_items) {
      return res.status(400).json({ error: "Invalid invoice payload" });
    }

    const batch = db.batch();
    invoice.line_items.forEach(lineItem => {
      if (lineItem.item_id) {
        const itemRef = db.collection('products').doc(lineItem.item_id);
        batch.set(itemRef, {
          stock: admin.firestore.FieldValue.increment(-Math.abs(lineItem.quantity)),
          updatedAt: new Date().toISOString()
        }, { merge: true });
      }
    });

    await batch.commit();
    res.status(200).json({ success: true, message: "Firebase stock decremented." });
  } catch (error) {
    console.error("Invoice Webhook Error:", error);
    res.status(500).json({ error: "Failed to process invoice webhook." });
  }
});

// ==========================================
// 6. ROUTES: FIREBASE -> ZOHO (API APPROVAL)
// ==========================================
app.post('/api/approve-zoho-order', apiLimiter, verifyAdminAuth, async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({ success: false, error: "Order ID is required." });
  }

  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, error: "Order not found in Firebase." });
    }

    const orderData = orderDoc.data();

    if (orderData.zoho_invoice_id || orderData.status === 'approved') {
      return res.status(400).json({ success: false, error: "Order is already synced or approved." });
    }

    const lineItems = orderData.items.map(item => ({
      item_id: item.id,
      quantity: item.qty,
      rate: item.price
    }));

    const zohoPayload = {
      customer_id: process.env.ZOHO_DEFAULT_CUSTOMER_ID,
      line_items: lineItems,
      shipping_charge: orderData.deliveryFee || 0,
      notes: `Online Order ID: ${orderId}. Address: ${orderData.deliveryAddress?.city}`
    };

    const accessToken = await getZohoAccessToken();
    const zohoUrl = `https://www.zohoapis.in/inventory/v1/invoices?organization_id=${process.env.ZOHO_ORG_ID}`;
    
    const zohoResponse = await axios.post(zohoUrl, zohoPayload, {
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const zohoInvoiceId = zohoResponse.data.invoice.invoice_id;
    const now = new Date().toISOString();

    await orderRef.update({
      status: 'approved', 
      zoho_invoice_id: zohoInvoiceId,
      zoho_invoice_status: 'generated',
      approvedAt: now,
      updatedAt: now,
      approvedBy: req.user.uid 
    });

    res.status(200).json({ 
      success: true, 
      message: "Order approved and synced to Zoho", 
      zoho_invoice_id: zohoInvoiceId 
    });

  } catch (error) {
    // Extracts exact error message from Zoho API, or falls back to standard error
    const errorMessage = error.response?.data?.message || error.message || "Failed to push order to Zoho ERP. Please try again.";
    console.error("Order Approval Error:", errorMessage);
    
    res.status(500).json({ 
      success: false, 
      error: errorMessage 
    });
  }
});

// ==========================================
// 7. START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Aarvi Backend running on port ${PORT}`);
});
