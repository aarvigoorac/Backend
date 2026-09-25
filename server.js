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
    // Safely handles newlines in the private key from cloud environment variables
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
// 3. HELPER: FIREBASE KEYWORD GENERATOR
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
// 4. ROUTES: GOFRUGAL -> FIREBASE (INVENTORY WEBHOOK)
// ==========================================
// Gofrugal will hit this URL when an item is added or stock/price changes
app.post('/webhook/gofrugal-item-sync', async (req, res) => {
  try {
    // Gofrugal usually wraps the payload in an "items" array or sends a single object
    const payload = req.body;
    const itemsList = payload.items ? payload.items : [payload];

    if (!itemsList || itemsList.length === 0) {
      return res.status(400).json({ error: "Invalid Gofrugal payload format" });
    }

    const batch = db.batch();

    itemsList.forEach(item => {
      if (!item.itemId) return; // Skip invalid entries
      
      const itemRef = db.collection('products').doc(item.itemId.toString());
      
      // Extract data from Gofrugal's specific nested "stock" array
      const stockData = item.stock && item.stock.length > 0 ? item.stock[0] : {};

      const updateData = {
        name: item.itemName,
        sku: stockData.itemReferenceCode || "",
        price: Number(stockData.salePrice) || 0,
        stock: Number(stockData.stock) || 0,
        mrp: Number(stockData.mrp) || 0, // Helpful to show discounts
        updatedAt: new Date().toISOString()
      };

      // Generate keywords for search engine
      updateData.searchKeywords = generateSearchKeywords(item.itemName, "", "", stockData.itemReferenceCode);

      batch.set(itemRef, updateData, { merge: true });
    });

    await batch.commit();
    res.status(200).json({ success: true, message: `Successfully synced ${itemsList.length} items from Gofrugal.` });
  } catch (error) {
    console.error("Gofrugal Webhook Sync Error:", error);
    res.status(500).json({ error: "Internal Server Error during Gofrugal sync" });
  }
});

// ==========================================
// 5. ROUTES: FIREBASE -> GOFRUGAL (PUSH SALES ORDER)
// ==========================================
// Your Admin/Agent PWA calls this when an order is Delivered
app.post('/api/approve-gofrugal-order', apiLimiter, verifyAdminAuth, async (req, res) => {
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

    if (orderData.gofrugal_reference_no || orderData.status === 'approved') {
      return res.status(400).json({ success: false, error: "Order is already synced to Gofrugal." });
    }

    // Format the line items for Gofrugal
    const mappedOrderItems = orderData.items.map((item, index) => ({
      rowNo: index + 1,
      itemId: item.id,
      itemName: item.name,
      quantity: item.qty,
      salePrice: item.price,
      itemAmount: item.qty * item.price
    }));

    // Construct the exact JSON payload Gofrugal requires
    const gofrugalPayload = {
      salesOrder: {
        onlineReferenceNo: orderId,
        createdAt: new Date().toISOString().replace('T', ' ').substring(0, 19), // Format: YYYY-MM-DD HH:MM:SS
        status: "pending",
        totalQuantity: orderData.items.reduce((sum, item) => sum + item.qty, 0),
        totalAmount: orderData.totalAmount,
        shippingCharge: orderData.deliveryFee || 0,
        
        // Customer Data Mapping
        customerName: orderData.deliveryAddress?.name || "Online Customer",
        customerMobile: orderData.deliveryAddress?.phone || "",
        customerCity: orderData.deliveryAddress?.city || "",
        customerAddressLine1: orderData.deliveryAddress?.house || "",
        customerAddressLine2: orderData.deliveryAddress?.area || "",
        customerPincode: orderData.deliveryAddress?.pincode || "",
        
        orderItems: mappedOrderItems
      }
    };

    // The URL Gofrugal provides you (e.g., http://[IP]/WebReporter/api/v1/salesOrders)
    const gofrugalApiUrl = `${process.env.GOFRUGAL_API_URL}/salesOrders`;
    
    // Push to Gofrugal using their Static Header Token
    const gofrugalResponse = await axios.post(gofrugalApiUrl, gofrugalPayload, {
      headers: {
        'X-Auth-Token': process.env.GOFRUGAL_AUTH_TOKEN,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    const now = new Date().toISOString();

    // Mark as approved in Firebase
    await orderRef.update({
      status: 'approved', 
      gofrugal_reference_no: orderId, 
      gofrugal_sync_status: 'success',
      approvedAt: now,
      updatedAt: now,
      approvedBy: req.user.uid 
    });

    res.status(200).json({ 
      success: true, 
      message: "Order successfully injected into Gofrugal ERP", 
      orderId: orderId 
    });

  } catch (error) {
    // Graceful error extraction from Gofrugal's API
    const errorMessage = error.response?.data?.message || error.message || "Failed to push order to Gofrugal ERP.";
    console.error("Gofrugal Order Push Error:", errorMessage);
    
    res.status(500).json({ 
      success: false, 
      error: errorMessage 
    });
  }
});

// ==========================================
// 6. START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Aarvi/Gofrugal Middleware running on port ${PORT}`);
});
