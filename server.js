require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const Stripe = require('stripe');

// ==========================================
// 1. INITIALIZATION & SECURITY SETUP
// ==========================================
const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet()); // Secures HTTP headers


// API Rate Limiting (Prevents spam/DDoS)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
    message: { error: "Too many requests from this IP, please try again after 15 minutes." }
});
app.use('/api', apiLimiter);

// Firebase Admin Setup
// Ensure you download your service account JSON from Firebase Console and place it in the same folder
const serviceAccount = require('./firebase-service-account.json');
initializeApp({
    credential: cert(serviceAccount)
});

// Stripe Setup (Add STRIPE_SECRET_KEY to your .env file)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');


// ==========================================
// 2. MONGODB SCHEMAS & MODELS
// ==========================================
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    firebaseUid: { type: String, required: true, unique: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

const hotelSchema = new mongoose.Schema({
    title: { type: String, required: true },
    location: { type: String, required: true },
    pricePerNight: { type: Number, required: true },
    currency: { type: String, default: 'BDT' },
    image: { type: String, required: true }
}, { timestamps: true });
const Hotel = mongoose.model('Hotel', hotelSchema);

const bookingSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    hotel: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true },
    pnr: { type: String, required: true, unique: true },
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, required: true },
    guests: {
        adults: { type: Number, default: 2 },
        children: { type: Number, default: 0 }
    },
    totalAmount: { type: Number, required: true },
    currency: { type: String, default: 'BDT' },
    status: { type: String, enum: ['pending', 'confirmed', 'cancelled'], default: 'pending' },
    payment: {
        method: { type: String, enum: ['bkash', 'nagad', 'card', 'stripe'], required: true },
        status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
        transactionId: { type: String }
    }
}, { timestamps: true });
const Booking = mongoose.model('Booking', bookingSchema);


// ==========================================
// 3. MIDDLEWARE (AUTH & ADMIN CHECK)
// ==========================================
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized access. Token missing.' });
    }
    
    const token = authHeader.split(' ')[1];
    
    try {
        const decodedToken = await getAuth().verifyIdToken(token);
        
        // ১. প্রথমে firebaseUid দিয়ে খোঁজার চেষ্টা করবে
        let user = await User.findOne({ firebaseUid: decodedToken.uid });

        if (!user) {
            // ২. যদি firebaseUid দিয়ে না পায়, তবে ইমেইল দিয়ে খুঁজবে (Duplicate Key Error এড়াতে)
            user = await User.findOne({ email: decodedToken.email });
            
            if (user) {
                // যদি ইমেইল ডাটাবেজে থাকে, তবে তার firebaseUid আপডেট করে দিবে
                user.firebaseUid = decodedToken.uid;
                await user.save();
            } else {
                // ৩. যদি একদমই নতুন ইউজার হয়, তবে ক্রিয়েট করবে
                user = await User.create({
                    email: decodedToken.email,
                    firebaseUid: decodedToken.uid,
                    role: 'user' // ডিফল্ট রোল 'user'
                });
            }
        }
        req.user = user;
        next();
    } catch (error) {
        console.error("🔴 Token Verification Error:", error.message); 
        return res.status(403).json({ error: 'Invalid or expired token.', details: error.message });
    }
};

const verifyAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Admin access required.' });
    }
};

const generatePNR = () => Math.random().toString(36).substring(2, 8).toUpperCase();


// ==========================================
// 4. API ROUTES
// ==========================================

// --- AUTH ROUTE ---
app.get('/api/auth/me', verifyToken, (req, res) => {
    res.json(req.user);
});

// --- HOTEL ROUTES ---
app.get('/api/hotels', async (req, res) => {
    try {
        const hotels = await Hotel.find().sort({ createdAt: -1 });
        res.json(hotels);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/hotels', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const hotel = await Hotel.create(req.body);
        res.status(201).json(hotel);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/hotels/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const hotel = await Hotel.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(hotel);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/hotels/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        await Hotel.findByIdAndDelete(req.params.id);
        res.json({ message: 'Hotel deleted' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- BOOKING ROUTES ---
app.post('/api/bookings', verifyToken, async (req, res) => {
    try {
        const { hotelId, checkIn, checkOut, guests, paymentMethod } = req.body;
        const hotel = await Hotel.findById(hotelId);
        if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

        // Calculate nights and total amount
        const inDate = new Date(checkIn);
        const outDate = new Date(checkOut);
        const nights = Math.max(1, Math.round((outDate - inDate) / (1000 * 60 * 60 * 24)));
        const totalAmount = nights * hotel.pricePerNight;

        const booking = await Booking.create({
            user: req.user._id,
            hotel: hotelId,
            pnr: generatePNR(),
            checkIn,
            checkOut,
            guests,
            totalAmount,
            currency: hotel.currency,
            payment: { method: paymentMethod, status: 'pending' }
        });

        res.status(201).json(booking);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Get user's own bookings
app.get('/api/bookings/mine', verifyToken, async (req, res) => {
    try {
        const bookings = await Booking.find({ user: req.user._id })
            .populate('hotel', 'title location image')
            .sort({ createdAt: -1 });
        res.json(bookings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// User cancels their own booking
app.patch('/api/bookings/:id/cancel', verifyToken, async (req, res) => {
    try {
        const booking = await Booking.findOneAndUpdate(
            { _id: req.params.id, user: req.user._id },
            { status: 'cancelled' },
            { new: true }
        );
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        res.json(booking);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// User permanently deletes their own booking (or admin deletes any booking)
// This is a hard delete from MongoDB — used by the "Cancel" button on the client.
app.delete('/api/bookings/:id', verifyToken, async (req, res) => {
    try {
        const filter = req.user.role === 'admin'
            ? { _id: req.params.id }
            : { _id: req.params.id, user: req.user._id };

        const booking = await Booking.findOneAndDelete(filter);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        res.json({ message: 'Booking deleted', _id: req.params.id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin gets all bookings
app.get('/api/bookings', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const bookings = await Booking.find()
            .populate('user', 'email')
            .populate('hotel', 'title location')
            .sort({ createdAt: -1 });
        res.json(bookings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin updates booking status
app.patch('/api/bookings/:id/status', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const booking = await Booking.findByIdAndUpdate(
            req.params.id,
            { status: req.body.status },
            { new: true }
        );
        res.json(booking);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- PAYMENT ROUTES ---
app.post('/api/payments/stripe/create-intent', verifyToken, async (req, res) => {
    try {
        const { bookingId } = req.body;
        const booking = await Booking.findById(bookingId);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(booking.totalAmount * 100), // Stripe expects smallest currency unit (cents/poisha)
            currency: booking.currency.toLowerCase(),
            metadata: { bookingId: booking._id.toString(), pnr: booking.pnr }
        });

        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/payments/bkash/create', verifyToken, async (req, res) => {
    // Basic Stub for bKash Redirect URL creation
    const { bookingId } = req.body;
    const booking = await Booking.findById(bookingId);
    // In a real scenario, you call bKash APIs here. For now, we mock the success redirect back to frontend.
    res.json({ bkashURL: `http://localhost:5500/index.html?payment=bkash&ok=1&pnr=${booking.pnr}` });
});

app.post('/api/payments/nagad/create', verifyToken, async (req, res) => {
    // Basic Stub for Nagad Redirect URL creation
    const { bookingId } = req.body;
    const booking = await Booking.findById(bookingId);
    res.json({ redirectURL: `http://localhost:5500/index.html?payment=nagad&ok=1&pnr=${booking.pnr}` });
});


// ==========================================
// 5. SERVER STARTUP
// ==========================================
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/travelheart';

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('✅ MongoDB Connected');
        app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
    })
    .catch(err => console.error('❌ MongoDB connection error:', err));