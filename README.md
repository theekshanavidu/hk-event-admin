# HK Event Management — Admin Control Center (Cloudflare Native)

Directed by **Keshara Sahan**, this repository contains the **Admin Control Center**, **Cloudflare R2 Media Gallery Manager**, and **Firebase Firestore Sync**.
It is engineered to run **100% serverless on Cloudflare Pages** with **ZERO server management, ZERO hosting costs, and direct Cloudflare R2 edge uploads**.

---

## ☁️ How to Host on Cloudflare Pages (Serverless / No Server)

### Step 1: Push to your GitHub Repository
Open terminal in this directory (`hk-event-admin`) and push:
```bash
git init
git add .
git commit -m "Deploy HK Event Admin Portal"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/hk-event-admin.git
git push -u origin main
```

### Step 2: Connect to Cloudflare Pages
1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. In the left navigation, go to **Compute (Workers & Pages)** > **Pages** > Click **Connect to Git**.
3. Select your repository `hk-event-admin`.
4. Configure Build settings:
   * **Framework preset:** `None`
   * **Build command:** *(leave empty)*
   * **Build output directory:** `public`
5. Click **Save and Deploy**.

### Step 3: Bind the Cloudflare R2 Bucket (1 Click)
To enable direct edge uploads to your `hkevent` R2 bucket:
1. In Cloudflare Pages, go to **Settings** > **Functions**.
2. Scroll to **R2 bucket bindings** > Click **Add binding**.
3. Set:
   * **Variable name:** `hkevent`
   * **R2 bucket:** `hkevent`
4. Click **Save**.

### Step 4: Add Environment Variables
In Cloudflare Pages > **Settings** > **Environment Variables**, add:
* `ADMIN_EMAIL`: `keshara@hkevent.lk`
* `ADMIN_PASSWORD`: `admin123`
* `FIREBASE_PROJECT_ID`: `hkevent-522e9`
* `FIREBASE_API_KEY`: `AIzaSyBIyOSZmWlDzgGODjZik44cf-I5e3hxYT0`
* `R2_PUBLIC_URL`: `https://pub-c47f04a613d14342a14ecef1be67548b.r2.dev`

Now redeploy or make a new commit. Your Admin Portal will be live at `https://hk-event-admin.pages.dev/dashboard` without running any Node.js server!

---

## 💻 Local Testing (Optional)
If you want to run locally with Node.js on your computer:
```bash
npm install
npm start
```
Visit [http://localhost:5000/dashboard](http://localhost:5000/dashboard).

---

## 📁 Repository Structure
```
hk-event-admin/
├── public/                # Admin Web UI served by Cloudflare Pages Edge
│   ├── index.html         # Admin Login Page
│   ├── dashboard.html     # Admin Dashboard & Media Manager
│   ├── _redirects         # Clean URL routing (/dashboard, /login)
│   ├── _headers           # Security & CORS Headers
│   ├── logo.png
│   ├── sahan.png
│   ├── css/               # Admin Styles
│   └── js/                # Admin Logic
├── functions/             # Cloudflare Pages Edge Functions (Serverless API)
│   └── api/
│       └── [[route]].js   # Cloudflare Edge APIs & Direct R2 Storage Uploads
├── data/                  # Fallback local databases
├── server.js              # Local development server
├── package.json
└── .env
```

---

## 👨‍💻 Developer Credit
Developed by [Theekshana Viduranga](https://theekshanavidu.github.io/portfolio/).
