// ===================================================================
// CLOUDFLARE PAGES EDGE FUNCTION: /api/[[route]]
// Zero-Server Cloudflare-Native REST API & Cloudflare R2 Uploads
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

// Helper to convert Firestore document format to clean JS object
function cleanFirestoreDoc(doc) {
  if (!doc || !doc.fields) return { id: doc.name?.split("/").pop() };
  const obj = { id: doc.name.split("/").pop() };
  for (const [k, v] of Object.entries(doc.fields)) {
    if (v.stringValue !== undefined) obj[k] = v.stringValue;
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
    else if (v.integerValue !== undefined) obj[k] = parseInt(v.integerValue, 10);
    else if (v.doubleValue !== undefined) obj[k] = parseFloat(v.doubleValue);
    else if (v.timestampValue !== undefined) obj[k] = v.timestampValue;
    else if (v.arrayValue !== undefined) {
      obj[k] = (v.arrayValue.values || []).map(item => {
        if (item.mapValue) return cleanFirestoreDoc(item.mapValue);
        return item.stringValue || item;
      });
    } else if (v.mapValue !== undefined) {
      obj[k] = cleanFirestoreDoc(v.mapValue);
    }
  }
  return obj;
}

// Helper to convert clean JS object into Firestore document fields
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

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  const projectId = env.FIREBASE_PROJECT_ID || "hkevent-522e9";
  const apiKey = env.FIREBASE_API_KEY || "AIzaSyBIyOSZmWlDzgGODjZik44cf-I5e3hxYT0";
  const firestoreBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const r2PublicUrl = (env.R2_PUBLIC_URL || "https://pub-c47f04a613d14342a14ecef1be67548b.r2.dev").replace(/\/+$/, "");

  try {
    // ---------------------------------------------------------------
    // 1. Healthcheck & System Status
    // ---------------------------------------------------------------
    if (path === "/api/system/status" && method === "GET") {
      const hasR2Binding = !!(env.hkevent || env.BUCKET);
      return jsonResponse({
        status: "ok",
        platform: "Cloudflare Pages (Serverless Edge)",
        r2Binding: hasR2Binding ? "active" : "configured via API",
        r2Bucket: env.R2_BUCKET_NAME || "hkevent",
        r2PublicUrl,
        firestoreProject: projectId,
        adminEmail: env.ADMIN_EMAIL || "keshara@hkevent.lk"
      });
    }

    // ---------------------------------------------------------------
    // 2. Inquiries API
    // ---------------------------------------------------------------
    if (path === "/api/inquiries") {
      if (method === "GET") {
        const res = await fetch(`${firestoreBase}/inquiries?key=${apiKey}`);
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

        const res = await fetch(`${firestoreBase}/inquiries?documentId=${id}&key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
      if (method === "PATCH") {
        const body = await request.json();
        const res = await fetch(`${firestoreBase}/inquiries/${inqId}?updateMask.fieldPaths=status&key=${apiKey}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { status: { stringValue: body.status || "reviewed" } } })
        });
        const updated = cleanFirestoreDoc(await res.json());
        return jsonResponse({ success: true, inquiry: updated });
      }

      if (method === "DELETE") {
        await fetch(`${firestoreBase}/inquiries/${inqId}?key=${apiKey}`, { method: "DELETE" });
        return jsonResponse({ success: true, message: "Inquiry deleted" });
      }
    }

    // ---------------------------------------------------------------
    // 3. Projects API
    // ---------------------------------------------------------------
    if (path === "/api/projects") {
      if (method === "GET") {
        const includeDrafts = url.searchParams.get("all") === "true";
        const res = await fetch(`${firestoreBase}/projects?key=${apiKey}`);
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

        await fetch(`${firestoreBase}/projects?documentId=${id}&key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: toFirestoreFields(newProject) })
        });

        return jsonResponse({ success: true, project: newProject }, 201);
      }
    }

    const projMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projMatch) {
      const idOrSlug = projMatch[1];
      if (method === "GET") {
        const res = await fetch(`${firestoreBase}/projects?key=${apiKey}`);
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
        const updated = {
          ...body,
          updatedAt: new Date().toISOString()
        };
        await fetch(`${firestoreBase}/projects/${idOrSlug}?key=${apiKey}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: toFirestoreFields(updated) })
        });
        return jsonResponse({ success: true, project: updated });
      }

      if (method === "DELETE") {
        await fetch(`${firestoreBase}/projects/${idOrSlug}?key=${apiKey}`, { method: "DELETE" });
        return jsonResponse({ success: true, message: "Project deleted" });
      }
    }

    // ---------------------------------------------------------------
    // 4. Cloudflare R2 Uploads (Native Cloudflare Edge Storage)
    // ---------------------------------------------------------------
    const r2Bucket = env.hkevent || env.BUCKET;

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

      // Upload directly into Cloudflare R2 bucket at edge!
      if (r2Bucket) {
        await r2Bucket.put(key, fileBuffer, {
          httpMetadata: { contentType: fileType }
        });
      } else {
        console.warn("R2 bucket binding not found on Cloudflare Pages. Binding name should be: hkevent");
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

    // Add image to Project Gallery
    const projImagesMatch = path.match(/^\/api\/projects\/([^/]+)\/images$/);
    if (projImagesMatch && method === "POST") {
      const projId = projImagesMatch[1];
      const formData = await request.formData();
      const file = formData.get("image");
      const caption = formData.get("caption") || "Event Photograph";
      const altText = formData.get("altText") || caption;

      if (!file || typeof file !== "object") {
        return jsonResponse({ success: false, error: "No image file provided" }, 400);
      }

      const fileBuffer = await file.arrayBuffer();
      const fileType = file.type || "image/jpeg";
      const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
      const key = `projects/${projId}/${filename}`;

      if (r2Bucket) {
        await r2Bucket.put(key, fileBuffer, {
          httpMetadata: { contentType: fileType }
        });
      }

      const finalUrl = `${r2PublicUrl}/${key}`;

      // Fetch existing project to append image
      const projRes = await fetch(`${firestoreBase}/projects/${projId}?key=${apiKey}`);
      if (projRes.ok) {
        const projData = cleanFirestoreDoc(await projRes.json());
        const images = projData.images || [];
        const newImg = {
          id: "img_" + Date.now(),
          url: finalUrl,
          r2Key: key,
          thumbnailUrl: finalUrl,
          caption,
          altText,
          sortOrder: images.length + 1,
          createdAt: new Date().toISOString()
        };
        images.push(newImg);
        projData.images = images;
        if (!projData.coverImage || projData.coverImage.includes("unsplash.com")) {
          projData.coverImage = finalUrl;
        }
        await fetch(`${firestoreBase}/projects/${projId}?key=${apiKey}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: toFirestoreFields(projData) })
        });
        return jsonResponse({ success: true, image: newImg, project: projData }, 201);
      }

      return jsonResponse({ success: true, url: finalUrl, r2Key: key });
    }

    // Delete image from Project Gallery
    const delImgMatch = path.match(/^\/api\/projects\/([^/]+)\/images\/([^/]+)$/);
    if (delImgMatch && method === "DELETE") {
      const [, projId, imageId] = delImgMatch;
      const projRes = await fetch(`${firestoreBase}/projects/${projId}?key=${apiKey}`);
      if (projRes.ok) {
        const projData = cleanFirestoreDoc(await projRes.json());
        let images = projData.images || [];
        const imgToDelete = images.find(img => img.id === imageId);
        images = images.filter(img => img.id !== imageId);
        projData.images = images;

        await fetch(`${firestoreBase}/projects/${projId}?key=${apiKey}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
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
