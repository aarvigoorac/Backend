require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

// ==========================================
// 1. FIREBASE ADMIN INITIALIZATION
// ==========================================
// Ensure you set these environment variables in your Render dashboard
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Fixes formatting issues with private keys in environment variables
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  })
});

const db = admin.firestore();
const app = express();

// Middleware
app.use(cors({ origin: true })); // Allows your PWA to call this API
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 2. SECURITY & RATE LIMITING
// ==========================================
// Prevents spam clicks from the Admin App exhausting Zoho limits
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 30, // Limit each IP to 30 requests per minute
  message: { error: "Too many requests. Please wait a minute and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware to verify Firebase Auth Token (Ensures only logged-in admins can approve orders)
async function verifyAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    // Optional: Double-check Firestore to see if this user has admin: true
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
  // Return cached token if it is still valid for at least 1 more minute
  if (cachedZohoToken && Date.now() < tokenExpiryTime) {
    return cachedZohoToken;
  }
  try {
    const url = `https://accounts.zoho.in/oauth/v2/token?refresh_token=${process.env.ZOHO_REFRESH_TOKEN}&client_id=${process.env.ZOHO_CLIENT_ID}&client_secret=${process.env.ZOHO_CLIENT_SECRET}&grant_type=refresh_token`;
    const response = await axios.post(url);
    
    cachedZohoToken = response.data.access_token;
    // Set expiry (usually 3600 seconds), subtracting 60 seconds as a safety buffer
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

// Webhook: Triggered by Zoho when an item is Created or Updated
app.post('/webhook/zoho-item-sync', async (req, res) => {
  try {
    // Zoho webhooks usually send data inside a JSON string under a specific key, parse accordingly
    const payload = req.body.JSONString ? JSON.parse(req.body.JSONString) : req.body;
    const item = payload.item; // Assumes Zoho Inventory item module payload

    if (!item || !item.item_id) {
      return res.status(400).json({ error: "Invalid payload format" });
    }

    const itemRef = db.collection('products').doc(item.item_id);
    const existingDoc = await itemRef.get();

    // Prepare safe update payload
    const updateData = {
      name: item.name,
      sku: item.sku || "",
      price: Number(item.rate) || 0,
      stock: Number(item.stock_on_hand) || 0,
      category: item.category_name || "General",
      brand: item.brand || "",
      isActive: item.status === "active",
      updatedAt: new Date().toISOString()
    };

    // Only regenerate keywords if the item is brand new, or if text fields changed
    const isNew = !existingDoc.exists;
    const nameChanged = existingDoc.exists && existingDoc.data().name !== item.name;
    
    if (isNew || nameChanged) {
      updateData.searchKeywords = generateSearchKeywords(item.name, item.brand, item.category_name, item.sku);
    }

    // merge: true PROTECTS YOUR CUSTOM IMAGES UPLOADED VIA ADMIN PWA
    await itemRef.set(updateData, { merge: true });

    res.status(200).json({ success: true, message: `Item ${item.item_id} synced.` });
  } catch (error) {
    console.error("Webhook Sync Error:", error);
    res.status(500).json({ error: "Internal Server Error during sync" });
  }
});

// Webhook: Triggered by Zoho when an Invoice is created (Walk-in Sales)
app.post('/webhook/zoho-invoice-sync', async (req, res) => {
  try {
    const payload = req.body.JSONString ? JSON.parse(req.body.JSONString) : req.body;
    const invoice = payload.invoice;

    if (!invoice || !invoice.line_items) {
      return res.status(400).json({ error: "Invalid invoice payload" });
    }

    // Deduct stock for each line item sold in the physical shop
    const batch = db.batch();
    invoice.line_items.forEach(lineItem => {
      if (lineItem.item_id) {
        const itemRef = db.collection('products').doc(lineItem.item_id);
        // decrement stock by the quantity sold
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

// Endpoint: Called by Admin PWA to approve an order and push it to Zoho
app.post('/api/approve-zoho-order', apiLimiter, verifyAdminAuth, async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({ error: "Order ID is required." });
  }

  try {
    // 1. Fetch order from Firebase
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Order not found in Firebase." });
    }

    const orderData = orderDoc.data();

    // Prevent double-syncing
    if (orderData.zoho_invoice_id || orderData.status === 'Approved') {
      return res.status(400).json({ error: "Order is already synced or approved." });
    }

    // 2. Prepare payload for Zoho Invoice/Sales Order API
    // (Map Firebase cart items to Zoho line_items)
    const lineItems = orderData.items.map(item => ({
      item_id: item.id, // Assumes item.id in Firebase is the Zoho item_id
      quantity: item.qty,
      rate: item.price
    }));

    // Example Zoho Invoice Payload (Adjust based on your exact Zoho settings)
    const zohoPayload = {
      customer_id: process.env.ZOHO_DEFAULT_CUSTOMER_ID, // Use a default "Online Customer" ID, or map specific customers
      line_items: lineItems,
      shipping_charge: orderData.deliveryFee || 0,
      notes: `Online Order ID: ${orderId}. Address: ${orderData.deliveryAddress?.city}`
    };

    // 3. Call Zoho API
    const accessToken = await getZohoAccessToken();
    const zohoUrl = `https://www.zohoapis.in/inventory/v1/invoices?organization_id=${process.env.ZOHO_ORG_ID}`;
    
    const zohoResponse = await axios.post(zohoUrl, zohoPayload, {
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const zohoInvoiceId = zohoResponse.data.invoice.invoice_id;

    // 4. Update Firebase Order Status & Attach Zoho ID
    await orderRef.update({
      status: 'Approved',
      zoho_invoice_id: zohoInvoiceId,
      approvedAt: new Date().toISOString(),
      approvedBy: req.user.uid // Logs which admin clicked approve
    });

    res.status(200).json({ success: true, message: "Order approved and synced to Zoho", zoho_invoice_id: zohoInvoiceId });

  } catch (error) {
    console.error("Order Approval Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to push order to Zoho ERP. Please try again." });
  }
});

// ==========================================
// 7. START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Aarvi Backend running on port ${PORT}`);
});
