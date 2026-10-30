require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const Stripe = require('stripe');
const crypto = require('crypto');

// ==========================================
// 1. INITIALIZATION & SECURITY SETUP
// ==========================================
const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet()); 
    
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: { error: "Too many requests from this IP, please try again after 15 minutes." }
});
app.use('/api', apiLimiter);

const serviceAccount = require('./firebase-service-account.json');
initializeApp({
    credential: cert(serviceAccount)
});



// ==========================================
// 2. MONGODB SCHEMAS & MODELS
// ==========================================
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    firebaseUid: { type: String, required: true, unique: true },
    role: { type: String, enum: ['user', 'admin', 'agent'], default: 'user' },
    referralCode: { type: String, default: 'PENDING' }, 
    pendingComm: { type: Number, default: 0 },
    paidComm: { type: Number, default: 0 }
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
    },
    appliedReferralCode: { type: String, default: null },
    // Unguessable token used by the QR code on the PDF ticket (public verification page)
    ticketToken: { type: String, default: () => crypto.randomBytes(12).toString('hex'), index: true }
}, { timestamps: true, toJSON: { virtuals: true } });

// Link encoded in the ticket's QR code. Set PUBLIC_URL in .env to your live server address
// (e.g. https://api.yoursite.com) so phones can open it.
bookingSchema.virtual('ticketUrl').get(function () {
    const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/+$/, '');
    return `${base}/ticket/${this.ticketToken}`;
});
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
        
        let user = await User.findOne({ firebaseUid: decodedToken.uid });

        if (!user) {
            user = await User.findOne({ email: decodedToken.email });
            
            if (user) {
                user.firebaseUid = decodedToken.uid;
                await user.save();
            } else {
                user = await User.create({
                    email: decodedToken.email,
                    firebaseUid: decodedToken.uid,
                    role: 'user' 
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

// --- PUBLIC TICKET VERIFICATION PAGE (opened by scanning the QR code on the PDF ticket) ---
const ticketLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });

const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' });
const fmtWeekday = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Asia/Dhaka' });

function renderTicketPage(b) {
    const nights = Math.max(1, Math.round((new Date(b.checkOut) - new Date(b.checkIn)) / 86400000));
    const adults = b.guests && b.guests.adults != null ? b.guests.adults : 2;
    const children = b.guests && b.guests.children != null ? b.guests.children : 0;
    const methodNames = { bkash: 'bKash', nagad: 'Nagad', card: 'Card', stripe: 'Card (Stripe)' };
    const payStatus = (b.payment && b.payment.status) || 'pending';
    const status = {
        confirmed: { color: '#10b981', text: 'CONFIRMED', note: 'This booking is confirmed and valid.' },
        pending: { color: '#f59e0b', text: 'PENDING', note: 'Awaiting confirmation. Not valid for check-in until confirmed.' },
        cancelled: { color: '#ef4444', text: 'CANCELLED', note: 'This booking has been cancelled.' }
    }[b.status] || { color: '#f59e0b', text: String(b.status).toUpperCase(), note: '' };
    const payColor = payStatus === 'paid' ? '#10b981' : payStatus === 'failed' ? '#ef4444' : '#f59e0b';
    const hotel = b.hotel || {};
    const guestEmail = b.user && b.user.email ? b.user.email : '-';
    const amount = `${escHtml(b.currency || 'BDT')} ${Number(b.totalAmount).toLocaleString('en-US')}`;

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ticket ${escHtml(b.pnr)} | TravelHutt</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#f3f7fb;color:#0a1f44}
.header{background:#012a62;color:#fff;padding:22px 20px 26px;text-align:center;position:relative}
.header:after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:linear-gradient(90deg,#0076b5,#00bab8)}
.brand{font-size:26px;font-weight:900;letter-spacing:.5px}.brand span{color:#00d6d3}
.sub{font-size:13px;color:#96e8e6;margin-top:4px}
.wrap{max-width:560px;margin:-14px auto 40px;padding:0 14px}
.card{background:#fff;border-radius:18px;box-shadow:0 8px 30px rgba(1,42,98,.12);overflow:hidden}
.banner{padding:14px 20px;color:#fff;font-weight:800;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.banner small{font-weight:600;opacity:.95;font-size:12px}
.sec{padding:18px 20px;border-bottom:1px solid #e2e8f0}.sec:last-child{border-bottom:none}
.lbl{font-size:10px;font-weight:800;letter-spacing:1px;color:#64748b;text-transform:uppercase;margin-bottom:4px}
.val{font-size:15px;font-weight:700;word-break:break-word}
.pnr{font-family:"Courier New",monospace;font-size:34px;font-weight:900;color:#00a3a2;letter-spacing:3px}
.hotel{font-size:20px;font-weight:800}.loc{color:#64748b;font-size:14px;margin-top:2px}
.himg{width:100%;height:170px;object-fit:cover;border-radius:12px;margin-top:12px;display:block}
.stay{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#f3f7fb;border-radius:12px;padding:14px}
.stay .d{font-size:16px;font-weight:800}.stay .w{font-size:12px;color:#64748b}
.nights{background:#012a62;color:#fff;border-radius:50%;width:54px;height:54px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex:none}
.nights b{font-size:18px;line-height:1}.nights i{font-style:normal;font-size:8px;color:#96e8e6;letter-spacing:1px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.total{font-size:20px;font-weight:900;color:#00a3a2}
.foot{text-align:center;color:#64748b;font-size:12px;margin-top:16px}
</style></head><body>
<div class="header"><div class="brand">Travel<span>Hutt</span></div><div class="sub">Booking ticket verification</div></div>
<div class="wrap"><div class="card">
  <div class="banner" style="background:${status.color}"><span>${status.text}</span><small>${escHtml(status.note)}</small></div>
  <div class="sec"><div class="lbl">Booking reference</div><div class="pnr">${escHtml(b.pnr)}</div>
    <div class="lbl" style="margin-top:10px">Booked on</div><div class="val">${escHtml(fmtDate(b.createdAt || b.checkIn))}</div></div>
  <div class="sec"><div class="lbl">Hotel</div><div class="hotel">${escHtml(hotel.title || 'Hotel')}</div>
    <div class="loc">${escHtml(hotel.location || '')}</div>
    ${hotel.image ? `<img class="himg" src="${escHtml(hotel.image)}" alt="">` : ''}</div>
  <div class="sec"><div class="stay">
    <div><div class="lbl">Check-in</div><div class="d">${escHtml(fmtDate(b.checkIn))}</div><div class="w">${escHtml(fmtWeekday(b.checkIn))}</div></div>
    <div class="nights"><b>${nights}</b><i>${nights > 1 ? 'NIGHTS' : 'NIGHT'}</i></div>
    <div style="text-align:right"><div class="lbl">Check-out</div><div class="d">${escHtml(fmtDate(b.checkOut))}</div><div class="w">${escHtml(fmtWeekday(b.checkOut))}</div></div>
  </div></div>
  <div class="sec"><div class="grid">
    <div><div class="lbl">Guest email</div><div class="val">${escHtml(guestEmail)}</div></div>
    <div><div class="lbl">Guests</div><div class="val">${adults} Adult${adults === 1 ? '' : 's'}${children ? ` + ${children} Child${children === 1 ? '' : 'ren'}` : ''}</div></div>
    <div><div class="lbl">Payment method</div><div class="val">${escHtml(methodNames[b.payment && b.payment.method] || (b.payment && b.payment.method) || '-')}</div></div>
    <div><div class="lbl">Payment status</div><div class="val" style="color:${payColor}">${escHtml(payStatus.toUpperCase())}</div></div>
    <div><div class="lbl">Referral code</div><div class="val">${escHtml(b.appliedReferralCode || '-')}</div></div>
    <div><div class="lbl">Total amount</div><div class="total">${amount}</div></div>
  </div></div>
</div>
<div class="foot">Live status from TravelHutt &middot; Present a valid photo ID at check-in.</div></div>
</body></html>`;
}

app.get('/ticket/:token', ticketLimiter, async (req, res) => {
    res.set({
        'Content-Security-Policy': "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        'Cache-Control': 'no-store'
    });
    try {
        const token = req.params.token;
        const booking = /^[a-f0-9]{24}$/.test(token)
            ? await Booking.findOne({ ticketToken: token }).populate('user', 'email').populate('hotel', 'title location image')
            : null;
        if (!booking) {
            return res.status(404).type('html').send('<!DOCTYPE html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font-family:Arial;text-align:center;padding:60px 20px"><h2>Ticket not found</h2><p>This ticket link is invalid or the booking no longer exists.</p></body>');
        }
        res.type('html').send(renderTicketPage(booking));
    } catch (err) {
        res.status(500).type('html').send('<!DOCTYPE html><body style="font-family:Arial;text-align:center;padding:60px 20px"><h2>Something went wrong</h2></body>');
    }
});

// --- AUTH ROUTE ---
app.get('/api/auth/me', verifyToken, (req, res) => {
    res.json(req.user);
});

// Admin gets all users
app.get('/api/users', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const users = await User.find().sort({ createdAt: -1 });
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin updates user role (AND Generates Agent Code)
app.patch('/api/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { role } = req.body;

        if (!['user', 'admin', 'agent'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role provided.' });
        }

        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        user.role = role;
        
        if (role === 'agent' && (user.referralCode === 'PENDING' || !user.referralCode)) {
            user.referralCode = 'AG-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        }

        await user.save();
        res.json(user);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin marks agent commission as paid
app.post('/api/users/:id/pay-commission', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        if (user.pendingComm > 0) {
            user.paidComm += user.pendingComm;
            user.pendingComm = 0;
            await user.save();
        }

        res.json(user);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
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
        const { hotelId, checkIn, checkOut, guests, paymentMethod, appliedReferralCode } = req.body;
        const hotel = await Hotel.findById(hotelId);
        if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

        const inDate = new Date(checkIn);
        const outDate = new Date(checkOut);
        const nights = Math.round((outDate - inDate) / (1000 * 60 * 60 * 24));
        if (isNaN(nights) || nights < 2) {
            return res.status(400).json({ error: 'Minimum 2 days booking required.' });
        }
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
            payment: { method: paymentMethod, status: 'pending' },
            appliedReferralCode: appliedReferralCode || null
        });

        if (appliedReferralCode) {
            const agent = await User.findOne({ referralCode: appliedReferralCode, role: 'agent' });
            if (agent) {
                const commission = 50; 
                agent.pendingComm += commission;
                await agent.save();
            }
        }

        res.status(201).json(booking);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Agent gets bookings made with their referral code
app.get('/api/bookings/agent', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'agent') return res.status(403).json({ error: 'Agent access only.' });
        const code = req.user.referralCode;
        if (!code || code === 'PENDING') return res.json([]);
        const bookings = await Booking.find({ appliedReferralCode: code })
            .populate('user', 'email')
            .populate('hotel', 'title location image')
            .sort({ createdAt: -1 });
        res.json(bookings);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        const booking = await Booking.findOne({ _id: req.params.id, user: req.user._id });
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        if (booking.status === 'confirmed') {
            return res.status(403).json({ error: 'This booking is confirmed and cannot be cancelled. Please contact support.' });
        }

        if (booking.status !== 'cancelled') {
            booking.status = 'cancelled';
            await booking.save();

            // Deduct commission from agent
            if (booking.appliedReferralCode) {
                const agent = await User.findOne({ referralCode: booking.appliedReferralCode, role: 'agent' });
                if (agent) {
                    agent.pendingComm = Math.max(0, agent.pendingComm - 50);
                    await agent.save();
                }
            }
        }

        res.json(booking);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Hard delete booking (User or Admin)
app.delete('/api/bookings/:id', verifyToken, async (req, res) => {
    try {
        const filter = req.user.role === 'admin'
            ? { _id: req.params.id }
            : { _id: req.params.id, user: req.user._id };

        const booking = await Booking.findOne(filter);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        if (req.user.role !== 'admin' && booking.status === 'confirmed') {
            return res.status(403).json({ error: 'This booking is confirmed and cannot be cancelled. Please contact support.' });
        }

        // Deduct commission if the booking wasn't already cancelled before deletion
        if (booking.status !== 'cancelled' && booking.appliedReferralCode) {
            const agent = await User.findOne({ referralCode: booking.appliedReferralCode, role: 'agent' });
            if (agent) {
                agent.pendingComm = Math.max(0, agent.pendingComm - 50);
                await agent.save();
            }
        }

        await Booking.deleteOne({ _id: booking._id });

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
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        const oldStatus = booking.status;
        const newStatus = req.body.status;

        if (!['pending', 'confirmed', 'cancelled'].includes(newStatus)) {
            return res.status(400).json({ error: 'Invalid status provided.' });
        }
        if (oldStatus === newStatus) return res.json(booking);

        booking.status = newStatus;

        // Payment follows admin confirmation: confirmed -> paid, restored to pending -> pending
        if (newStatus === 'confirmed') booking.payment.status = 'paid';
        else if (newStatus === 'pending') booking.payment.status = 'pending';

        await booking.save();

        // Adjust commission based on status change
        if (booking.appliedReferralCode) {
            const agent = await User.findOne({ referralCode: booking.appliedReferralCode, role: 'agent' });
            if (agent) {
                if (oldStatus !== 'cancelled' && newStatus === 'cancelled') {
                    // Booking was active, now cancelled -> Deduct 50
                    agent.pendingComm = Math.max(0, agent.pendingComm - 50);
                    await agent.save();
                } else if (oldStatus === 'cancelled' && (newStatus === 'confirmed' || newStatus === 'pending')) {
                    // Booking was cancelled, now restored -> Add 50 back
                    agent.pendingComm += 50;
                    await agent.save();
                }
            }
        }

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
            amount: Math.round(booking.totalAmount * 100), 
            currency: booking.currency.toLowerCase(),
            metadata: { bookingId: booking._id.toString(), pnr: booking.pnr }
        });

        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/payments/bkash/create', verifyToken, async (req, res) => {
    const { bookingId } = req.body;
    const booking = await Booking.findById(bookingId);
    res.json({ bkashURL: `http://localhost:5500/index.html?payment=bkash&ok=1&pnr=${booking.pnr}` });
});

app.post('/api/payments/nagad/create', verifyToken, async (req, res) => {
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
    .then(async () => {
        console.log('✅ MongoDB Connected[cite: 5]');
        // Give every older booking a ticket token (needed for the QR verification page)
        const missing = await Booking.find({ ticketToken: null }).select('_id');
        for (const m of missing) {
            await Booking.updateOne({ _id: m._id }, { $set: { ticketToken: crypto.randomBytes(12).toString('hex') } });
        }
        if (missing.length) console.log(`🎫 Added ticket tokens to ${missing.length} older booking(s)`);
        app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}[cite: 5]`));
    })
    .catch(err => console.error('❌ MongoDB connection error:', err));
