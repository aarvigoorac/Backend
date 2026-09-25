const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

// ==========================================
// 1. FIREBASE ADMIN INITIALIZATION
// ==========================================
let serviceAccount;

try {
  // Parses the full JSON string pasted into your cloud environment variable
  // This eliminates \n parsing errors and keeps credentials secure in one variable.
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error("FATAL: Failed to parse FIREBASE_SERVICE_ACCOUNT JSON. Check your environment variable.", err.message);
  process.exit(1); // Stop server if credentials are missing or malformed
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
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
// Protects your API from brute-force attacks and spam
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per windowMs
  message: { error: "Too many requests. Please wait a minute and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware to ensure only authorized Admins can push orders to Gofrugal
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
// Generates n-gram keywords for blazing fast Firebase frontend searching
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
// Gofrugal Cloud will hit this URL automatically when an item is added, or stock/price changes locally
app.post('/webhook/gofrugal-item-sync', async (req, res) => {
  try {
    const payload = req.body;
    // Gofrugal usually wraps the payload in an "items" array, but might send a single object
    const itemsList = payload.items ? payload.items : [payload];

    if (!itemsList || itemsList.length === 0) {
      return res.status(400).json({ error: "Invalid Gofrugal payload format" });
    }

    const batch = db.batch();

    itemsList.forEach(item => {
      if (!item.itemId) return; // Skip invalid or malformed entries
      
      const itemRef = db.collection('products').doc(item.itemId.toString());
      
      // Extract data from Gofrugal's specific nested "stock" array
      const stockData = item.stock && item.stock.length > 0 ? item.stock[0] : {};

      const updateData = {
        name: item.itemName,
        sku: stockData.itemReferenceCode || "",
        price: Number(stockData.salePrice) || 0,
        stock: Number(stockData.stock) || 0,
        mrp: Number(stockData.mrp) || 0, // Keeps track of original MRP for frontend discounts
        updatedAt: new Date().toISOString()
      };

      // Generate search keywords automatically for the frontend search bar
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
// Your Admin/Agent PWA calls this when an order is marked 'Delivered'
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

    // Prevent double-billing in Gofrugal
    if (orderData.gofrugal_reference_no || orderData.status === 'approved') {
      return res.status(400).json({ success: false, error: "Order is already synced to Gofrugal." });
    }

    // Format the line items specifically for Gofrugal's Sales Order schema
    const mappedOrderItems = orderData.items.map((item, index) => ({
      rowNo: index + 1,
      itemId: item.id,
      itemName: item.name,
      quantity: item.qty,
      salePrice: item.price,
      itemAmount: item.qty * item.price
    }));

    // Construct the exact JSON payload Gofrugal Cloud expects
    const gofrugalPayload = {
      salesOrder: {
        onlineReferenceNo: orderId,
        createdAt: new Date().toISOString().replace('T', ' ').substring(0, 19), // Gofrugal expects YYYY-MM-DD HH:MM:SS
        status: "pending", // Allows local cashier to finalize or review if needed
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

    // Construct API URL using the base URL provided by Gofrugal Support
    const gofrugalApiUrl = `${process.env.GOFRUGAL_API_URL}/salesOrders`;
    
    // Push the order to Gofrugal Cloud
    const gofrugalResponse = await axios.post(gofrugalApiUrl, gofrugalPayload, {
      headers: {
        'X-Auth-Token': process.env.GOFRUGAL_AUTH_TOKEN, // Static token generated in WebReporter
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    const now = new Date().toISOString();

    // Mark as approved and link the Gofrugal Reference ID in Firebase
    await orderRef.update({
      status: 'approved', 
      gofrugal_reference_no: orderId, // You can swap this with gofrugalResponse.data.salesOrderId if Gofrugal returns one
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
    // Extract exact error message from Gofrugal's API rejection (e.g., "Invalid itemId" or "Tax mismatch")
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
