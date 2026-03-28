require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Health check ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Bingsu backend running' });
});

// ─── Send OTP ──────────────────────────────────────────────
app.post('/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await supabase.from('otp_codes').delete().eq('phone', phone);
  await supabase.from('otp_codes').insert({ phone, code, expires_at });
  console.log(`OTP for ${phone}: ${code}`);
  // TODO: Send via CallMeBot/WATI when ready
  res.json({ success: true, message: 'OTP sent' });
});

// ─── Check member exists ───────────────────────────────────
app.post('/auth/check-member', async (req, res) => {
  const { phone } = req.body;
  const { data } = await supabase.from('members').select('id').eq('phone', phone).single();
  res.json({ exists: !!data });
});

// ─── Verify OTP ────────────────────────────────────────────
app.post('/auth/verify-otp', async (req, res) => {
  const { phone, code, name } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

  const { data: otpRow } = await supabase
    .from('otp_codes').select('*')
    .eq('phone', phone).eq('code', code).eq('used', false)
    .gt('expires_at', new Date().toISOString()).single();

  if (!otpRow) return res.status(400).json({ error: 'Invalid or expired OTP' });
  await supabase.from('otp_codes').update({ used: true }).eq('id', otpRow.id);

  let { data: member } = await supabase.from('members').select('*').eq('phone', phone).single();
  if (!member) {
    if (!name) return res.status(400).json({ error: 'Name required for new member' });
    const { data: newMember, error } = await supabase
      .from('members').insert({
        phone, name, tier: 'silver', points: 0, stamps: 0, visits: 0,
        join_year: String(new Date().getFullYear()), referrals: 0, transactions: []
      }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    member = newMember;
  }
  if (member.is_banned) return res.status(403).json({ error: 'Account suspended' });
  res.json({ success: true, member });
});

// ─── Get open slots ────────────────────────────────────────
app.get('/slots', async (req, res) => {
  const { data, error } = await supabase.from('slots').select('*')
    .eq('is_open', true)
    .gte('slot_date', new Date().toISOString().split('T')[0])
    .order('slot_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── Get toppings ──────────────────────────────────────────
app.get('/toppings', async (req, res) => {
  const { data, error } = await supabase.from('toppings').select('*').eq('is_available', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── Create reservation ────────────────────────────────────
app.post('/reservations', async (req, res) => {
  const { member_id, slot_id, flavors, toppings } = req.body;
  if (!member_id || !slot_id || !flavors || !flavors.length)
    return res.status(400).json({ error: 'Missing required fields' });
  if (flavors.length > 2) return res.status(400).json({ error: 'Max 2 flavors' });
  if (toppings && toppings.length > 3) return res.status(400).json({ error: 'Max 3 toppings' });

  const { data: member } = await supabase.from('members').select('*').eq('id', member_id).single();
  if (!member || member.is_banned) return res.status(403).json({ error: 'Account suspended' });

  const { data: slot } = await supabase.from('slots').select('*').eq('id', slot_id).single();
  if (!slot || !slot.is_open) return res.status(400).json({ error: 'Slot not available' });
  if (slot.reserved_quota >= slot.total_quota) return res.status(400).json({ error: 'Slot is full' });

  const { data: existing } = await supabase.from('reservations')
    .select('id').eq('member_id', member_id).eq('slot_id', slot_id).single();
  if (existing) return res.status(400).json({ error: 'Already reserved this slot' });

  const count = slot.reserved_quota + 1;
  const ticket_number = `A-${String(count).padStart(3, '0')}`;

  const { data: reservation, error } = await supabase.from('reservations')
    .insert({ member_id, slot_id, flavors, toppings: toppings || [], ticket_number })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('slots').update({ reserved_quota: count }).eq('id', slot_id);
  console.log(`New reservation: ${ticket_number} for ${member.name} (${member.phone})`);
  res.json({ success: true, reservation });
});

// ─── Get single member ─────────────────────────────────────
app.get('/member/:id', async (req, res) => {
  const { data, error } = await supabase.from('members').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// ─── Update member ─────────────────────────────────────────
app.post('/member/update', async (req, res) => {
  const { member_id, token, ...updates } = req.body;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  delete updates.id; delete updates.phone;
  await supabase.from('members').update(updates).eq('id', member_id);
  res.json({ success: true });
});

// ─── Add points ────────────────────────────────────────────
app.post('/member/add-points', async (req, res) => {
  const { token, member_id, points, add_stamp, note } = req.body;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { data: m } = await supabase.from('members').select('*').eq('id', member_id).single();
  if (!m) return res.status(404).json({ error: 'Member not found' });
  const newPoints = (m.points || 0) + points;
  const newStamps = add_stamp ? Math.min(10, (m.stamps || 0) + 1) : (m.stamps || 0);
  const newVisits = (m.visits || 0) + 1;
  const newTier = newPoints >= 6000 ? 'blackgold' : newPoints >= 3000 ? 'black' : newPoints >= 1000 ? 'gold' : 'silver';
  const txs = m.transactions || [];
  txs.unshift({ type: 'earn', label: note || 'Points added', pts: points, date: new Date().toLocaleDateString() });
  await supabase.from('members').update({
    points: newPoints, stamps: newStamps, visits: newVisits, tier: newTier, transactions: txs.slice(0, 50)
  }).eq('id', member_id);
  res.json({ success: true, points: newPoints, tier: newTier });
});

// ─── Add stamp ─────────────────────────────────────────────
app.post('/member/add-stamp', async (req, res) => {
  const { token, member_id } = req.body;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { data: m } = await supabase.from('members').select('stamps').eq('id', member_id).single();
  if (!m) return res.status(404).json({ error: 'Not found' });
  await supabase.from('members').update({ stamps: Math.min(10, (m.stamps || 0) + 1) }).eq('id', member_id);
  res.json({ success: true });
});

// ─── Redeem points ─────────────────────────────────────────
app.post('/member/redeem', async (req, res) => {
  const { member_id, item_name, points_used } = req.body;
  const { data: m } = await supabase.from('members').select('*').eq('id', member_id).single();
  if (!m) return res.status(404).json({ error: 'Not found' });
  if ((m.points || 0) < points_used) return res.status(400).json({ error: 'Not enough points' });
  const txs = m.transactions || [];
  txs.unshift({ type: 'spend', label: 'Redeemed — ' + item_name, pts: -points_used, date: new Date().toLocaleDateString() });
  await supabase.from('members').update({ points: (m.points || 0) - points_used, transactions: txs.slice(0, 50) }).eq('id', member_id);
  await supabase.from('redemptions').insert({ member_id, item_name, points_used });
  res.json({ success: true });
});

// ─── Redeem stamp ──────────────────────────────────────────
app.post('/member/redeem-stamp', async (req, res) => {
  const { member_id } = req.body;
  const { data: m } = await supabase.from('members').select('*').eq('id', member_id).single();
  if (!m || (m.stamps || 0) < 10) return res.status(400).json({ error: 'Not enough stamps' });
  const txs = m.transactions || [];
  txs.unshift({ type: 'spend', label: 'Stamp Redemption — Free Drink', pts: 0, date: new Date().toLocaleDateString() });
  await supabase.from('members').update({ stamps: 0, transactions: txs.slice(0, 50) }).eq('id', member_id);
  res.json({ success: true });
});

// ─── Shop items ────────────────────────────────────────────
app.get('/shop-items', async (req, res) => {
  const { data, error } = await supabase.from('shop_items').select('*').eq('is_available', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── Admin: Login ──────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });
  res.json({ success: true, token: process.env.ADMIN_PASSWORD });
});

// ─── Admin: Get reservations by date ──────────────────────
app.get('/admin/reservations', async (req, res) => {
  const { date, token } = req.query;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { data: slots } = await supabase.from('slots').select('*').eq('slot_date', date);
  if (!slots || !slots.length) return res.json([]);
  const slotIds = slots.map(s => s.id);
  const { data, error } = await supabase.from('reservations')
    .select('*, members(name, phone), slots(time_label)')
    .in('slot_id', slotIds);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── Admin: Add slot ───────────────────────────────────────
app.post('/admin/slots', async (req, res) => {
  const { token, slot_date, time_label, total_quota } = req.body;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabase.from('slots')
    .insert({ slot_date, time_label, total_quota }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, slot: data });
});

// ─── Admin: Add topping ────────────────────────────────────
app.post('/admin/toppings', async (req, res) => {
  const { token, name } = req.body;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabase.from('toppings').insert({ name }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, topping: data });
});

// ─── Admin: Delete topping ─────────────────────────────────
app.delete('/admin/toppings/:id', async (req, res) => {
  const { token } = req.body;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await supabase.from('toppings').update({ is_available: false }).eq('id', req.params.id);
  res.json({ success: true });
});

// ─── Admin: Get all members ────────────────────────────────
app.get('/admin/members', async (req, res) => {
  const { token } = req.query;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabase.from('members').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── Admin: Register member ────────────────────────────────
app.post('/admin/register', async (req, res) => {
  const { token, name, phone, birthday } = req.body;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { data: existing } = await supabase.from('members').select('id').eq('phone', phone).single();
  if (existing) return res.status(400).json({ error: 'Phone already registered' });
  const { data, error } = await supabase.from('members').insert({
    name, phone, birthday, tier: 'silver', points: 0, stamps: 0, visits: 0,
    join_year: String(new Date().getFullYear()), referrals: 0, transactions: []
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, member: data });
});

// ─── Admin: Ban member ─────────────────────────────────────
app.post('/admin/ban', async (req, res) => {
  const { token, member_id } = req.body;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await supabase.from('members').update({ is_banned: true }).eq('id', member_id);
  res.json({ success: true });
});

// ─── Admin: Unban member ───────────────────────────────────
app.post('/admin/unban', async (req, res) => {
  const { token, member_id } = req.body;
  if (token !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await supabase.from('members').update({ is_banned: false }).eq('id', member_id);
  res.json({ success: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
