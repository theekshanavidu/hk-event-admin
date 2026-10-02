require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");
const {
  getFirestore,
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc
} = require("firebase/firestore");

const app = express();
const PORT = process.env.PORT || 5000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// Enable CORS for public site requests from any domain/port
app.use(cors({
  origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map(s => s.trim()),
  credentials: true
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Multer memory storage for direct Cloudflare R2 uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

// Paths to local fallback storage
const DATA_DIR = path.join(__dirname, "data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const INQUIRIES_FILE = path.join(DATA_DIR, "inquiries.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (err) {
    console.error(`Error reading ${file}:`, err.message);
  }
  return [];
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error(`Error writing ${file}:`, err.message);
    return false;
  }
}

// ===================================================================
// CLOUDFLARE R2 S3 CLIENT
// ===================================================================
const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT || "https://dd332ab406cfff738014fda692d2a7e9.r2.cloudflarestorage.com",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "d2909024bcb971761e630d6589d1cbbb",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "963006c6303611c936bb290e2e0fcf2f41bf1a07f8dae01d3318d22be95ba92e"
  }
});

async function uploadBufferToR2(buffer, key, contentType) {
  const bucket = process.env.R2_BUCKET_NAME || "hkevent";
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  await r2Client.send(command);
  const publicBase = (process.env.R2_PUBLIC_URL || "https://pub-c47f04a613d14342a14ecef1be67548b.r2.dev").replace(/\/+$/, "");
  return `${publicBase}/${key}`;
}

// ===================================================================
// FIREBASE FIRESTORE INITIALIZATION & AUTH
// ===================================================================
let firestoreDb = null;
let fbAuth = null;
let currentFbUser = null;

try {
  const fbApp = initializeApp({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
  });
  fbAuth = getAuth(fbApp);
  firestoreDb = getFirestore(fbApp);
  console.log("[Firebase] Firestore successfully initialized.");
} catch (err) {
  console.warn("[Firebase] Initialization warning:", err.message);
}

async function ensureFbAuth() {
  if (!fbAuth) return null;
  try {
    if (!currentFbUser) {
      const email = process.env.ADMIN_EMAIL || "keshara@hkevent.lk";
      const pass = process.env.ADMIN_PASSWORD || "admin123";
      const cred = await signInWithEmailAndPassword(fbAuth, email, pass);
      currentFbUser = cred.user;
      console.log(`[Firebase Auth] Logged in as: ${currentFbUser.email}`);
    }
    return currentFbUser;
  } catch (err) {
    console.warn(`[Firebase Auth Notice]: ${err.message}`);
    return null;
  }
}

async function syncInquiryToFirestore(inquiry) {
  if (!firestoreDb) return false;
  try {
    await ensureFbAuth();
    await setDoc(doc(firestoreDb, "inquiries", inquiry.id), inquiry);
    console.log(`[Firestore] Inquiry ${inquiry.id} synced to Firestore.`);
    return true;
  } catch (err) {
    console.warn(`[Firestore Notice] Error syncing inquiry: ${err.message}`);
    return false;
  }
}

async function syncProjectToFirestore(project) {
  if (!firestoreDb) return false;
  try {
    await ensureFbAuth();
    await setDoc(doc(firestoreDb, "projects", project.id), project);
    console.log(`[Firestore] Project ${project.id} synced to Firestore.`);
    return true;
  } catch (err) {
    console.warn(`[Firestore Notice] Error syncing project: ${err.message}`);
    return false;
  }
}

async function deleteProjectFromFirestore(projectId) {
  if (!firestoreDb) return false;
  try {
    await ensureFbAuth();
    await deleteDoc(doc(firestoreDb, "projects", projectId));
    return true;
  } catch (err) {
    console.warn(`[Firestore Notice] Firestore delete error: ${err.message}`);
    return false;
  }
}

// Static Assets for Admin UI
app.use(express.static(path.join(__dirname, "public")));
app.use("/admin", express.static(path.join(__dirname, "public")));
app.use("/admin/css", express.static(path.join(__dirname, "public", "css")));
app.use("/admin/js", express.static(path.join(__dirname, "public", "js")));
app.use("/assets/css", express.static(path.join(__dirname, "public", "assets", "css")));

// Admin Page Routes
app.get(["/", "/admin", "/login"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get(["/dashboard", "/admin/dashboard"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ===================================================================
// REST API ENDPOINTS
// ===================================================================

// Healthcheck & Diagnostics
app.get("/api/system/status", async (req, res) => {
  let r2Status = "active";
  let firestoreStatus = "connected";

  try {
    const listCmd = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME || "hkevent",
      Key: "system/healthcheck.txt",
      Body: "ok",
      ContentType: "text/plain"
    });
    await r2Client.send(listCmd);
  } catch (e) {
    r2Status = "error: " + e.message;
  }

  res.json({
    status: "ok",
    service: "HK Event Management Admin & API Backend",
    r2Bucket: process.env.R2_BUCKET_NAME || "hkevent",
    r2PublicUrl: process.env.R2_PUBLIC_URL || "https://pub-c47f04a613d14342a14ecef1be67548b.r2.dev",
    r2Status,
    firestoreStatus,
    adminUser: process.env.ADMIN_EMAIL || "keshara@hkevent.lk"
  });
});

// Inquiries API
app.post("/api/inquiries", async (req, res) => {
  const { name, phone, email, type, date, guests, location, venue, message } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ success: false, error: "Name and Phone number are required." });
  }

  const inquiries = readJSON(INQUIRIES_FILE);
  const newInquiry = {
    id: "inq_" + Date.now(),
    name: name.trim(),
    phone: phone.trim(),
    email: (email || "").trim(),
    type: type || "Weddings",
    date: date || "",
    guests: guests || "",
    location: (venue || location || "").trim(),
    message: (message || "").trim(),
    status: "new",
    createdAt: new Date().toISOString()
  };

  inquiries.unshift(newInquiry);
  writeJSON(INQUIRIES_FILE, inquiries);
  const firestoreSaved = await syncInquiryToFirestore(newInquiry);

  res.status(201).json({
    success: true,
    message: "Inquiry received and submitted to Keshara Sahan!",
    inquiry: newInquiry,
    savedToFirestore: firestoreSaved
  });
});

app.get("/api/inquiries", async (req, res) => {
  if (firestoreDb) {
    try {
      await ensureFbAuth();
      const snap = await getDocs(collection(firestoreDb, "inquiries"));
      if (!snap.empty) {
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        return res.json({ success: true, inquiries: list, source: "firestore" });
      }
    } catch (e) {
      console.warn("Firestore inquiries fallback:", e.message);
    }
  }

  const inquiries = readJSON(INQUIRIES_FILE);
  res.json({ success: true, inquiries, source: "local" });
});

app.patch("/api/inquiries/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const inquiries = readJSON(INQUIRIES_FILE);
  const item = inquiries.find(i => i.id === id);

  if (!item) {
    return res.status(404).json({ success: false, error: "Inquiry not found" });
  }

  if (status) item.status = status;
  writeJSON(INQUIRIES_FILE, inquiries);
  await syncInquiryToFirestore(item);

  res.json({ success: true, inquiry: item });
});

app.delete("/api/inquiries/:id", async (req, res) => {
  const { id } = req.params;
  let inquiries = readJSON(INQUIRIES_FILE);
  inquiries = inquiries.filter(i => i.id !== id);
  writeJSON(INQUIRIES_FILE, inquiries);

  if (firestoreDb) {
    try {
      await ensureFbAuth();
      await deleteDoc(doc(firestoreDb, "inquiries", id));
    } catch (e) {}
  }

  res.json({ success: true, message: "Inquiry deleted" });
});

// Projects API
app.get("/api/projects", async (req, res) => {
  const includeDrafts = req.query.all === "true";
  let projects = [];

  if (firestoreDb) {
    try {
      await ensureFbAuth();
      const snap = await getDocs(collection(firestoreDb, "projects"));
      if (!snap.empty) {
        snap.forEach(d => projects.push({ id: d.id, ...d.data() }));
      }
    } catch (e) {
      console.warn("Firestore projects notice:", e.message);
    }
  }

  if (projects.length === 0) {
    projects = readJSON(PROJECTS_FILE);
  }

  if (!includeDrafts) {
    projects = projects.filter(p => p.status === "published");
  }

  res.json({ success: true, projects });
});

app.get("/api/projects/:idOrSlug", async (req, res) => {
  const { idOrSlug } = req.params;
  let project = null;

  if (firestoreDb) {
    try {
      await ensureFbAuth();
      const snap = await getDocs(collection(firestoreDb, "projects"));
      if (!snap.empty) {
        snap.forEach(d => {
          const p = { id: d.id, ...d.data() };
          if (p.id === idOrSlug || p.slug === idOrSlug) {
            project = p;
          }
        });
      }
    } catch (e) {}
  }

  if (!project) {
    const allProjects = readJSON(PROJECTS_FILE);
    project = allProjects.find(p => p.id === idOrSlug || p.slug === idOrSlug);
  }

  if (!project) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }

  res.json({ success: true, project });
});

app.post("/api/projects", async (req, res) => {
  const { title, slug, category, eventDate, location, client, attendees, coverImage, description, status, featured } = req.body;

  if (!title) {
    return res.status(400).json({ success: false, error: "Project title is required" });
  }

  const projects = readJSON(PROJECTS_FILE);
  const autoSlug = (slug || title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const newProject = {
    id: "proj_" + Date.now(),
    title: title.trim(),
    slug: autoSlug,
    category: category || "Weddings",
    eventDate: eventDate || new Date().toISOString().split("T")[0],
    location: location || "Sri Lanka",
    client: client || "",
    attendees: attendees || "",
    coverImage: coverImage || "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80",
    description: description || "",
    status: status || "published",
    featured: !!featured,
    images: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  projects.push(newProject);
  writeJSON(PROJECTS_FILE, projects);
  const firestoreSaved = await syncProjectToFirestore(newProject);

  res.status(201).json({
    success: true,
    message: "Project created successfully",
    project: newProject,
    savedToFirestore: firestoreSaved
  });
});

app.put("/api/projects/:id", async (req, res) => {
  const { id } = req.params;
  const projects = readJSON(PROJECTS_FILE);
  const idx = projects.findIndex(p => p.id === id);

  if (idx === -1) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }

  const updated = {
    ...projects[idx],
    ...req.body,
    updatedAt: new Date().toISOString()
  };

  projects[idx] = updated;
  writeJSON(PROJECTS_FILE, projects);
  const firestoreSaved = await syncProjectToFirestore(updated);

  res.json({ success: true, project: updated, savedToFirestore: firestoreSaved });
});

app.delete("/api/projects/:id", async (req, res) => {
  const { id } = req.params;
  let projects = readJSON(PROJECTS_FILE);
  projects = projects.filter(p => p.id !== id);
  writeJSON(PROJECTS_FILE, projects);

  await deleteProjectFromFirestore(id);
  res.json({ success: true, message: "Project deleted successfully" });
});

// Cloudflare R2 Uploads
app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    let fileBuffer = null;
    let mimeType = "image/jpeg";
    let filename = `upload-${Date.now()}.jpg`;

    if (req.file) {
      fileBuffer = req.file.buffer;
      mimeType = req.file.mimetype || "image/jpeg";
      filename = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
    } else if (req.body.dataUrl) {
      const match = req.body.dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1];
        fileBuffer = Buffer.from(match[2], "base64");
        const ext = mimeType.split("/")[1] || "jpg";
        filename = `${Date.now()}-${(req.body.filename || "image").replace(/[^a-zA-Z0-9.-]/g, "_")}.${ext}`;
      }
    }

    if (!fileBuffer) {
      return res.status(400).json({ success: false, error: "No image file or dataUrl provided." });
    }

    const folder = req.body.folder || "general";
    const key = `projects/${folder}/${filename}`;

    const r2Url = await uploadBufferToR2(fileBuffer, key, mimeType);
    console.log(`[Cloudflare R2] Uploaded: ${r2Url}`);

    res.json({
      success: true,
      url: r2Url,
      r2Key: key,
      size: fileBuffer.length,
      mimeType
    });
  } catch (err) {
    console.error("R2 Upload Error:", err);
    res.status(500).json({ success: false, error: "Cloudflare R2 upload failed: " + err.message });
  }
});

// Add image to Project
app.post("/api/projects/:id/images", upload.single("image"), async (req, res) => {
  const { id } = req.params;
  const allProjects = readJSON(PROJECTS_FILE);
  const project = allProjects.find(p => p.id === id);

  if (!project) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }

  let finalUrl = "";
  let r2Key = "";
  const caption = req.body.caption || project.title;
  const altText = req.body.altText || caption;

  try {
    if (req.file) {
      const filename = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
      r2Key = `projects/${project.slug || project.id}/${filename}`;
      finalUrl = await uploadBufferToR2(req.file.buffer, r2Key, req.file.mimetype || "image/jpeg");
    } else if (req.body.dataUrl) {
      const match = req.body.dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const buffer = Buffer.from(match[2], "base64");
        const ext = mimeType.split("/")[1] || "jpg";
        const filename = `${Date.now()}-${(caption || "photo").toLowerCase().replace(/[^a-z0-9]/g, "_")}.${ext}`;
        r2Key = `projects/${project.slug || project.id}/${filename}`;
        finalUrl = await uploadBufferToR2(buffer, r2Key, mimeType);
      }
    } else if (req.body.url) {
      let u = req.body.url.trim();
      if (u.startsWith("//")) u = "https:" + u;
      else if (!u.startsWith("http://") && !u.startsWith("https://") && !u.startsWith("data:") && !u.startsWith("/")) {
        u = "https://" + u;
      }
      finalUrl = u;
    }

    if (!finalUrl) {
      return res.status(400).json({ success: false, error: "Image file or valid URL is required" });
    }

    if (!project.images) project.images = [];
    const newImg = {
      id: "img_" + Date.now(),
      url: finalUrl,
      r2Key: r2Key,
      thumbnailUrl: finalUrl,
      caption: caption,
      altText: altText,
      sortOrder: project.images.length + 1,
      createdAt: new Date().toISOString()
    };

    project.images.push(newImg);
    if (!project.coverImage || project.coverImage.includes("unsplash.com")) {
      project.coverImage = finalUrl;
    }

    writeJSON(PROJECTS_FILE, allProjects);
    await syncProjectToFirestore(project);

    res.status(201).json({
      success: true,
      message: "Image added to project gallery and saved to Cloudflare R2 / Firestore",
      image: newImg,
      project
    });
  } catch (err) {
    console.error("Gallery add image error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete image from Project
app.delete("/api/projects/:id/images/:imageId", async (req, res) => {
  const { id, imageId } = req.params;
  const allProjects = readJSON(PROJECTS_FILE);
  const project = allProjects.find(p => p.id === id);

  if (!project || !project.images) {
    return res.status(404).json({ success: false, error: "Project or image not found" });
  }

  const imgToDelete = project.images.find(img => img.id === imageId);
  project.images = project.images.filter(img => img.id !== imageId);

  // If cover image was this image, reassign
  if (project.coverImage === (imgToDelete && imgToDelete.url)) {
    project.coverImage = project.images.length > 0 ? project.images[0].url : "";
  }

  writeJSON(PROJECTS_FILE, allProjects);
  await syncProjectToFirestore(project);

  if (imgToDelete && imgToDelete.r2Key) {
    try {
      const delCmd = new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME || "hkevent",
        Key: imgToDelete.r2Key
      });
      await r2Client.send(delCmd);
    } catch (e) {}
  }

  res.json({ success: true, message: "Image removed from project gallery", project });
});

app.listen(PORT, () => {
  console.log("=================================================");
  console.log(`HK Event Management — Admin Portal & REST API`);
  console.log(`Admin Portal: http://localhost:${PORT}/dashboard`);
  console.log(`Admin Login:  http://localhost:${PORT}/login`);
  console.log(`API Service:  http://localhost:${PORT}/api/system/status`);
  console.log(`CORS Origin:  ${CORS_ORIGIN}`);
  console.log("=================================================");
});
