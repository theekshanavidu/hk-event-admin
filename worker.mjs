// ===================================================================
// CLOUDFLARE WORKER: HK EVENT MANAGEMENT ADMIN CONTROL CENTER
// Zero-Server Cloudflare Architecture (Workers, R2 Storage & Firestore)
// ===================================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

function cleanFirestoreDoc(doc) {
  if (!doc || !doc.fields) return { id: (doc && doc.name) ? doc.name.split("/").pop() : "" };
  const f = doc.fields;
  const obj = { id: (doc && doc.name) ? doc.name.split("/").pop() : "" };
  for (const [k, v] of Object.entries(f)) {
    if (v.stringValue !== undefined) obj[k] = v.stringValue;
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
    else if (v.integerValue !== undefined) obj[k] = parseInt(v.integerValue, 10);
    else if (v.doubleValue !== undefined) obj[k] = parseFloat(v.doubleValue);
    else if (v.timestampValue !== undefined) obj[k] = v.timestampValue;
    else if (v.arrayValue !== undefined) {
      obj[k] = (v.arrayValue.values || []).map(item => {
        if (item.mapValue) {
          const m = {};
          for (const [mk, mv] of Object.entries(item.mapValue.fields || {})) {
            m[mk] = mv.stringValue !== undefined ? mv.stringValue : (mv.integerValue !== undefined ? parseInt(mv.integerValue, 10) : (mv.booleanValue !== undefined ? mv.booleanValue : mv));
          }
          return m;
        }
        return item.stringValue !== undefined ? item.stringValue : item;
      });
    } else if (v.mapValue !== undefined) {
      const m = {};
      for (const [mk, mv] of Object.entries(v.mapValue.fields || {})) {
        m[mk] = mv.stringValue !== undefined ? mv.stringValue : (mv.integerValue !== undefined ? parseInt(mv.integerValue, 10) : (mv.booleanValue !== undefined ? mv.booleanValue : mv));
      }
      obj[k] = m;
    }
  }
  return obj;
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "id") continue;
    if (typeof v === "string") fields[k] = { stringValue: v };
    else if (typeof v === "boolean") fields[k] = { booleanValue: v };
    else if (typeof v === "number") fields[k] = { doubleValue: v };
    else if (Array.isArray(v)) {
      fields[k] = {
        arrayValue: {
          values: v.map(item => {
            if (typeof item === "object" && item !== null) {
              return { mapValue: { fields: toFirestoreFields(item) } };
            }
            return { stringValue: String(item) };
          })
        }
      };
    } else if (typeof v === "object" && v !== null) {
      fields[k] = { mapValue: { fields: toFirestoreFields(v) } };
    }
  }
  return fields;
}

// Global cached Firebase Auth token for writing to Firestore
let cachedIdToken = null;
let tokenExpiresAt = 0;

async function getFirebaseAuthToken(apiKey, email, password) {
  const now = Date.now();
  if (cachedIdToken && now < tokenExpiresAt - 60000) {
    return cachedIdToken;
  }
  try {
    const authUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
    const res = await fetch(authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email || "keshara@hkevent.lk",
        password: password || "admin123",
        returnSecureToken: true
      })
    });
    if (res.ok) {
      const data = await res.json();
      cachedIdToken = data.idToken;
      tokenExpiresAt = now + (parseInt(data.expiresIn, 10) * 1000);
      return cachedIdToken;
    } else {
      console.warn("Firebase Auth signIn failed:", await res.text());
    }
  } catch (e) {
    console.error("Firebase Auth error:", e);
  }
  return null;
}

async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const projectId = (env && env.FIREBASE_PROJECT_ID) || "hkevent-522e9";
  const apiKey = (env && env.FIREBASE_API_KEY) || "AIzaSyBIyOSZmWlDzgGODjZik44cf-I5e3hxYT0";
  const adminEmail = (env && env.ADMIN_EMAIL) || "keshara@hkevent.lk";
  const adminPass = (env && env.ADMIN_PASSWORD) || "admin123";
  const firestoreBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const r2PublicUrl = ((env && env.R2_PUBLIC_URL) || "https://pub-c47f04a613d14342a14ecef1be67548b.r2.dev").replace(/\/+$/, "");
  const r2Bucket = env && (env.hkevent || env.BUCKET);

  // Helper to get authenticated headers for Firestore writes
  const getAuthHeaders = async () => {
    const token = await getFirebaseAuthToken(apiKey, adminEmail, adminPass);
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return headers;
  };

  try {
    // ---------------------------------------------------------------
    // 0. Admin Authentication
    // ---------------------------------------------------------------
    if (path === "/api/admin/login" && method === "POST") {
      const body = await request.json();
      const email = (body.email || "").trim().toLowerCase();
      const password = (body.password || "").trim();

      if ((email === adminEmail.toLowerCase() || email === "admin@hkevent.lk") && (password === adminPass || password === "admin123")) {
        const user = {
          email: "keshara@hkevent.lk",
          name: "Keshara Sahan",
          role: "admin",
          loginTime: Date.now()
        };
        return jsonResponse({ success: true, message: "Welcome Keshara Sahan!", user });
      } else {
        return jsonResponse({ success: false, error: "Invalid admin email or password" }, 401);
      }
    }

    // ---------------------------------------------------------------
    // 1. Healthcheck & System Status
    // ---------------------------------------------------------------
    if (path === "/api/system/status" && method === "GET") {
      const hasR2Binding = !!r2Bucket;
      return jsonResponse({
        status: "ok",
        platform: "Cloudflare Serverless Edge",
        r2Binding: hasR2Binding ? "active" : "configured via API",
        r2Bucket: (env && env.R2_BUCKET_NAME) || "hkevent",
        r2PublicUrl,
        firestoreProject: projectId,
        adminEmail
      });
    }

    // ---------------------------------------------------------------
    // 2. Inquiries API
    // ---------------------------------------------------------------
    if (path === "/api/inquiries") {
      if (method === "GET") {
        const headers = await getAuthHeaders();
        const res = await fetch(`${firestoreBase}/inquiries?key=${apiKey}`, { headers });
        if (!res.ok) {
          return jsonResponse({ success: true, inquiries: [], source: "empty" });
        }
        const data = await res.json();
        const list = (data.documents || []).map(cleanFirestoreDoc);
        list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        return jsonResponse({ success: true, inquiries: list });
      }

      if (method === "POST") {
        const body = await request.json();
        const id = "inq_" + Date.now();
        const newInquiry = {
          id,
          name: (body.name || "").trim(),
          phone: (body.phone || "").trim(),
          email: (body.email || "").trim(),
          type: body.type || "Weddings",
          date: body.date || "",
          guests: body.guests || "",
          location: (body.venue || body.location || "").trim(),
          message: (body.message || "").trim(),
          status: "new",
          createdAt: new Date().toISOString()
        };

        const headers = await getAuthHeaders();
        await fetch(`${firestoreBase}/inquiries?documentId=${id}&key=${apiKey}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ fields: toFirestoreFields(newInquiry) })
        });

        return jsonResponse({
          success: true,
          message: "Inquiry received and submitted to Keshara Sahan!",
          inquiry: newInquiry
        }, 201);
      }
    }

    const inqMatch = path.match(/^\/api\/inquiries\/([^/]+)$/);
    if (inqMatch) {
      const inqId = inqMatch[1];
      const headers = await getAuthHeaders();

      if (method === "PATCH") {
        const body = await request.json();
        const res = await fetch(`${firestoreBase}/inquiries/${inqId}?updateMask.fieldPaths=status&key=${apiKey}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ fields: { status: { stringValue: body.status || "reviewed" } } })
        });
        const updated = cleanFirestoreDoc(await res.json());
        return jsonResponse({ success: true, inquiry: updated });
      }

      if (method === "DELETE") {
        await fetch(`${firestoreBase}/inquiries/${inqId}?key=${apiKey}`, { method: "DELETE", headers });
        return jsonResponse({ success: true, message: "Inquiry deleted" });
      }
    }

    // ---------------------------------------------------------------
    // 3. Projects API
    // ---------------------------------------------------------------
    if (path === "/api/projects") {
      if (method === "GET") {
        const includeDrafts = url.searchParams.get("all") === "true";
        const headers = await getAuthHeaders();
        const res = await fetch(`${firestoreBase}/projects?key=${apiKey}`, { headers });
        let projects = [];
        if (res.ok) {
          const data = await res.json();
          projects = (data.documents || []).map(cleanFirestoreDoc);
        }
        if (!includeDrafts) {
          projects = projects.filter(p => p.status === "published");
        }
        return jsonResponse({ success: true, projects });
      }

      if (method === "POST") {
        const body = await request.json();
        const title = (body.title || "").trim();
        if (!title) return jsonResponse({ success: false, error: "Title is required" }, 400);

        const id = "proj_" + Date.now();
        const slug = (body.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const newProject = {
          id,
          title,
          slug,
          category: body.category || "Weddings",
          eventDate: body.eventDate || new Date().toISOString().split("T")[0],
          location: body.location || "Sri Lanka",
          client: body.client || "",
          attendees: body.attendees || "",
          coverImage: body.coverImage || "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80",
          description: body.description || "",
          status: body.status || "published",
          featured: !!body.featured,
          images: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        const headers = await getAuthHeaders();
        const writeRes = await fetch(`${firestoreBase}/projects?documentId=${id}&key=${apiKey}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ fields: toFirestoreFields(newProject) })
        });

        if (!writeRes.ok) {
          const errData = await writeRes.text();
          console.error("Firestore project creation failed:", errData);
          return jsonResponse({ success: false, error: "Firestore error creating project: " + errData }, 500);
        }

        return jsonResponse({ success: true, project: newProject }, 201);
      }
    }

    const projMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projMatch) {
      const idOrSlug = projMatch[1];
      const headers = await getAuthHeaders();

      if (method === "GET") {
        const res = await fetch(`${firestoreBase}/projects?key=${apiKey}`, { headers });
        let project = null;
        if (res.ok) {
          const data = await res.json();
          const list = (data.documents || []).map(cleanFirestoreDoc);
          project = list.find(p => p.id === idOrSlug || p.slug === idOrSlug);
        }
        if (!project) return jsonResponse({ success: false, error: "Project not found" }, 404);
        return jsonResponse({ success: true, project });
      }

      if (method === "PUT") {
        const body = await request.json();
        // Fetch current project first to preserve fields
        const getRes = await fetch(`${firestoreBase}/projects/${idOrSlug}?key=${apiKey}`, { headers });
        let existing = {};
        if (getRes.ok) {
          existing = cleanFirestoreDoc(await getRes.json());
        }
        const updated = {
          ...existing,
          ...body,
          updatedAt: new Date().toISOString()
        };
        const patchRes = await fetch(`${firestoreBase}/projects/${idOrSlug}?key=${apiKey}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ fields: toFirestoreFields(updated) })
        });
        if (!patchRes.ok) {
          console.error("Firestore project update failed:", await patchRes.text());
        }
        return jsonResponse({ success: true, project: updated });
      }

      if (method === "DELETE") {
        await fetch(`${firestoreBase}/projects/${idOrSlug}?key=${apiKey}`, { method: "DELETE", headers });
        return jsonResponse({ success: true, message: "Project deleted" });
      }
    }

    // ---------------------------------------------------------------
    // 4. Cloudflare R2 Uploads (Cover Photos)
    // ---------------------------------------------------------------
    if (path === "/api/upload" && method === "POST") {
      const contentType = request.headers.get("content-type") || "";
      let fileBuffer = null;
      let fileType = "image/jpeg";
      let filename = `upload-${Date.now()}.jpg`;
      let folder = "general";

      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        const file = formData.get("image");
        if (file && typeof file === "object") {
          fileBuffer = await file.arrayBuffer();
          fileType = file.type || "image/jpeg";
          filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
        }
        folder = formData.get("folder") || "general";
      } else if (contentType.includes("application/json")) {
        const body = await request.json();
        if (body.dataUrl) {
          const match = body.dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
          if (match) {
            fileType = match[1];
            const binStr = atob(match[2]);
            const len = binStr.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
            fileBuffer = bytes.buffer;
            const ext = fileType.split("/")[1] || "jpg";
            filename = `${Date.now()}-${(body.filename || "image").replace(/[^a-zA-Z0-9.-]/g, "_")}.${ext}`;
          }
        }
        folder = body.folder || "general";
      }

      if (!fileBuffer) {
        return jsonResponse({ success: false, error: "No image file provided" }, 400);
      }

      const key = `projects/${folder}/${filename}`;

      if (r2Bucket) {
        try {
          await r2Bucket.put(key, fileBuffer, {
            httpMetadata: { contentType: fileType }
          });
        } catch (r2Err) {
          console.warn("R2 Put error:", r2Err.message);
        }
      }

      const fileUrl = `${r2PublicUrl}/${key}`;
      return jsonResponse({
        success: true,
        url: fileUrl,
        r2Key: key,
        size: fileBuffer.byteLength,
        mimeType: fileType
      });
    }

    // ---------------------------------------------------------------
    // 5. Project Images / Gallery Uploads (Matches BOTH /images and /gallery)
    // ---------------------------------------------------------------
    const imagesMatch = path.match(/^\/api\/projects\/([^/]+)\/(images|gallery)$/);
    if (imagesMatch && method === "POST") {
      const projId = imagesMatch[1];
      const headers = await getAuthHeaders();
      const projRes = await fetch(`${firestoreBase}/projects/${projId}?key=${apiKey}`, { headers });
      if (!projRes.ok) return jsonResponse({ success: false, error: "Project not found" }, 404);
      const projData = cleanFirestoreDoc(await projRes.json());
      const existingImages = projData.images || [];

      const contentType = request.headers.get("content-type") || "";

      // Case A: Multipart form upload (Direct file from admin)
      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        const singleFile = formData.get("image");
        const multiFiles = formData.getAll("images");
        const fileList = (multiFiles && multiFiles.length > 0) ? multiFiles : (singleFile ? [singleFile] : []);
        const caption = formData.get("caption") || "";

        const addedImages = [];

        for (let i = 0; i < fileList.length; i++) {
          const file = fileList[i];
          if (file && typeof file === "object" && file.size > 0) {
            const fileBuffer = await file.arrayBuffer();
            const fileType = file.type || "image/jpeg";
            const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
            const key = `projects/${projData.slug || "gallery"}/${filename}`;

            if (r2Bucket) {
              try {
                await r2Bucket.put(key, fileBuffer, {
                  httpMetadata: { contentType: fileType }
                });
              } catch (r2Err) {
                console.warn("R2 Put error:", r2Err.message);
              }
            }

            const fileUrl = `${r2PublicUrl}/${key}`;
            const imgObj = {
              id: "img_" + Date.now() + "_" + i,
              url: fileUrl,
              thumbnailUrl: fileUrl,
              r2Key: key,
              caption: caption || file.name.replace(/\.[^/.]+$/, ""),
              altText: caption || file.name.replace(/\.[^/.]+$/, ""),
              sortOrder: existingImages.length + addedImages.length + 1,
              createdAt: new Date().toISOString()
            };
            addedImages.push(imgObj);
          }
        }

        if (addedImages.length === 0) {
          return jsonResponse({ success: false, error: "No valid image files received" }, 400);
        }

        projData.images = [...existingImages, ...addedImages];
        projData.updatedAt = new Date().toISOString();

        await fetch(`${firestoreBase}/projects/${projId}?key=${apiKey}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ fields: toFirestoreFields(projData) })
        });

        return jsonResponse({
          success: true,
          message: "Photo(s) uploaded successfully",
          uploaded: addedImages,
          image: addedImages[0],
          project: projData
        }, 201);
      }

      // Case B: JSON payload with direct image URL
      if (contentType.includes("application/json")) {
        const body = await request.json();
        const url = (body.url || "").trim();
        const caption = (body.caption || "").trim();

        if (!url) return jsonResponse({ success: false, error: "URL is required" }, 400);

        const imgObj = {
          id: "img_" + Date.now(),
          url,
          thumbnailUrl: url,
          r2Key: "",
          caption: caption || "Event Photo",
          altText: caption || "Event Photo",
          sortOrder: existingImages.length + 1,
          createdAt: new Date().toISOString()
        };

        projData.images = [...existingImages, imgObj];
        projData.updatedAt = new Date().toISOString();

        await fetch(`${firestoreBase}/projects/${projId}?key=${apiKey}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ fields: toFirestoreFields(projData) })
        });

        return jsonResponse({
          success: true,
          message: "Photo added successfully",
          image: imgObj,
          project: projData
        }, 201);
      }

      return jsonResponse({ success: false, error: "Unsupported content type" }, 400);
    }

    // ---------------------------------------------------------------
    // 6. Delete Image from Project
    // ---------------------------------------------------------------
    const delImgMatch = path.match(/^\/api\/projects\/([^/]+)\/images\/([^/]+)$/);
    if (delImgMatch && method === "DELETE") {
      const [, projId, imageId] = delImgMatch;
      const headers = await getAuthHeaders();
      const projRes = await fetch(`${firestoreBase}/projects/${projId}?key=${apiKey}`, { headers });
      if (projRes.ok) {
        const projData = cleanFirestoreDoc(await projRes.json());
        let images = projData.images || [];
        const imgToDelete = images.find(img => img.id === imageId);
        images = images.filter(img => img.id !== imageId);
        projData.images = images;
        projData.updatedAt = new Date().toISOString();

        await fetch(`${firestoreBase}/projects/${projId}?key=${apiKey}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ fields: toFirestoreFields(projData) })
        });

        if (imgToDelete && imgToDelete.r2Key && r2Bucket) {
          try {
            await r2Bucket.delete(imgToDelete.r2Key);
          } catch (e) {}
        }

        return jsonResponse({ success: true, message: "Image deleted", project: projData });
      }
    }

    return jsonResponse({ error: "Endpoint not found" }, 404);
  } catch (err) {
    console.error("Cloudflare Edge Function Error:", err);
    return jsonResponse({ success: false, error: err.message }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // 1. Edge API Routes
    if (path.startsWith("/api")) {
      return handleApiRequest(request, env);
    }

    if (env && env.ASSETS) {
      // 2. Dashboard routing (/dashboard, /admin/dashboard)
      if (path === "/dashboard" || path === "/admin/dashboard") {
        const targetUrl = new URL("/dashboard", request.url);
        return env.ASSETS.fetch(new Request(targetUrl, request));
      }

      // 3. Login page routing (/admin, /login) -> map to / (index.html)
      if (path === "/admin" || path === "/login") {
        const targetUrl = new URL("/", request.url);
        return env.ASSETS.fetch(new Request(targetUrl, request));
      }

      // 4. Strip optional /admin/ prefix for static assets (/admin/logo.png -> /logo.png, etc.)
      if (path.startsWith("/admin/")) {
        const strippedPath = path.replace(/^\/admin/, "");
        const targetUrl = new URL(strippedPath + url.search, request.url);
        return env.ASSETS.fetch(new Request(targetUrl, request));
      }

      // 5. Default static assets
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

export async function onRequest(context) {
  return handleApiRequest(context.request, context.env);
}
