'use strict';

const path = require('node:path');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const app = createApp({
  dbPath: process.env.DB_PATH || path.join(__dirname, 'data', 'carwash.db'),
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  adminName: process.env.ADMIN_NAME,
  secureCookies: process.env.SECURE_COOKIES === 'true',
  trustProxy: process.env.TRUST_PROXY,
});

app.listen(PORT, () => {
  console.log(`Car wash app running at http://localhost:${PORT}`);
  console.log(`  Admin panel:    http://localhost:${PORT}/admin`);
  console.log(`  Customer panel: http://localhost:${PORT}/app`);
});
