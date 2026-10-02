/* ===================================================================
   HK EVENT MANAGEMENT — ADMIN PORTAL CLIENT LOGIC
   Connects to Express Server API (/api/inquiries & /api/projects)
   =================================================================== */

let currentProjectFilter = "all";
let currentInquiryFilter = "all";
let adminSearchQuery = "";
let activeEditingProjectId = null;
let activeGalleryProjectId = null;

let inquiriesList = [];
let projectsList = [];

document.addEventListener("DOMContentLoaded", () => {
  checkAuth();
  loadInquiries();
  loadProjects();
  bindEvents();
});

// Guard session
function checkAuth() {
  const session = localStorage.getItem("hk_admin_session");
  if (!session) {
    window.location.href = "/admin";
    return;
  }
  try {
    const user = JSON.parse(session);
    if (!user || user.role !== "admin") {
      window.location.href = "/admin";
      return;
    }
    const nameEl = document.getElementById("admin-user-display");
    if (nameEl) nameEl.textContent = user.name || "Keshara Sahan";
  } catch (e) {
    window.location.href = "/admin";
  }
}

function logout() {
  localStorage.removeItem("hk_admin_session");
  window.location.href = "/admin";
}

// ===================================================================
// INQUIRIES MANAGEMENT (VIEW SUBMISSIONS TO KESHARA SAHAN)
// ===================================================================

async function loadInquiries() {
  try {
    const res = await fetch("/api/inquiries");
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.inquiries) {
        inquiriesList = data.inquiries;
      }
    }
  } catch (e) {
    console.error("Failed to load inquiries:", e);
  }
  updateInquiryCounters();
  renderInquiriesTable();
}

function updateInquiryCounters() {
  const newCount = inquiriesList.filter(i => i.status === "new").length;
  const badgeEl = document.getElementById("inquiry-nav-badge");
  if (badgeEl) {
    if (newCount > 0) {
      badgeEl.textContent = `${newCount} New`;
      badgeEl.style.display = "inline-block";
    } else {
      badgeEl.style.display = "none";
    }
  }
  const statEl = document.getElementById("stat-total-inquiries");
  if (statEl) statEl.textContent = inquiriesList.length;

  const statNewEl = document.getElementById("stat-new-inquiries");
  if (statNewEl) statNewEl.textContent = `${newCount} Pending`;
}

function renderInquiriesTable() {
  const tbody = document.getElementById("admin-inquiries-tbody");
  if (!tbody) return;

  let list = inquiriesList;
  if (currentInquiryFilter !== "all") {
    list = list.filter(i => i.status === currentInquiryFilter);
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:#94a3b8;">No inquiries found.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(inq => {
    // Format Phone for WhatsApp
    const rawPhone = (inq.phone || "").replace(/[^0-9]/g, "");
    let waPhone = rawPhone;
    if (waPhone.startsWith("0")) waPhone = "94" + waPhone.substring(1);
    if (!waPhone.startsWith("94") && waPhone.length === 9) waPhone = "94" + waPhone;

    const waMsg = encodeURIComponent(
      `Hello ${inq.name}, this is Keshara Sahan from HK Event Management. Thank you for your inquiry regarding your ${inq.type} on ${inq.date || 'your upcoming date'}. I would love to discuss your vision!`
    );

    const formattedDate = inq.createdAt ? new Date(inq.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Recent";

    return `
      <tr style="${inq.status === 'new' ? 'background:#fffbf0;' : ''}">
        <td>
          <div style="font-size:0.8rem;color:var(--admin-text-sub);">${formattedDate}</div>
          <span class="status-badge ${inq.status || 'new'}">${inq.status}</span>
        </td>
        <td>
          <div style="font-weight:700;color:var(--admin-text-main);">${inq.name}</div>
          <div style="font-size:0.8rem;color:var(--admin-text-sub);">${inq.email || 'No email provided'}</div>
        </td>
        <td>
          <div style="font-weight:600;">${inq.phone}</div>
          <div style="display:flex;gap:6px;margin-top:4px;">
            <a href="tel:${inq.phone}" class="act-btn call" title="Call Client">📞 Call</a>
            <a href="https://wa.me/${waPhone}?text=${waMsg}" target="_blank" class="act-btn whatsapp" title="Chat on WhatsApp">💬 WhatsApp</a>
          </div>
        </td>
        <td>
          <span style="font-weight:600;color:var(--admin-gold);">${inq.type}</span>
          <div style="font-size:0.8rem;color:var(--admin-text-sub);">${inq.date ? 'Target: ' + inq.date : 'Date TBD'}</div>
        </td>
        <td>
          <div style="font-size:0.85rem;">${inq.location || '—'}</div>
          <div style="font-size:0.78rem;color:var(--admin-text-sub);">${inq.guests || ''}</div>
        </td>
        <td style="max-width:240px;">
          <div style="font-size:0.85rem;line-height:1.4;color:var(--admin-text-main);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">
            ${inq.message || 'No additional message provided.'}
          </div>
        </td>
        <td>
          <div class="action-btn-group" style="flex-direction:column;align-items:flex-start;">
            <select class="form-select" style="padding:4px 8px;font-size:0.78rem;height:auto;" onchange="updateInquiryStatus('${inq.id}', this.value)">
              <option value="new" ${inq.status === 'new' ? 'selected' : ''}>Status: New</option>
              <option value="contacted" ${inq.status === 'contacted' ? 'selected' : ''}>Status: Contacted</option>
              <option value="booked" ${inq.status === 'booked' ? 'selected' : ''}>Status: Booked</option>
              <option value="archived" ${inq.status === 'archived' ? 'selected' : ''}>Status: Archived</option>
            </select>
            <button class="act-btn delete" style="padding:3px 8px;font-size:0.75rem;" onclick="deleteInquiryHandler('${inq.id}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

async function updateInquiryStatus(id, newStatus) {
  try {
    const res = await fetch(`/api/inquiries/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus })
    });
    if (res.ok) {
      const idx = inquiriesList.findIndex(i => i.id === id);
      if (idx !== -1) inquiriesList[idx].status = newStatus;
      updateInquiryCounters();
      renderInquiriesTable();
    }
  } catch (e) {
    console.error("Status update error:", e);
  }
}

async function deleteInquiryHandler(id) {
  if (confirm("Are you sure you want to delete this client inquiry?")) {
    try {
      const res = await fetch(`/api/inquiries/${id}`, { method: "DELETE" });
      if (res.ok) {
        inquiriesList = inquiriesList.filter(i => i.id !== id);
        updateInquiryCounters();
        renderInquiriesTable();
      }
    } catch (e) {
      console.error("Delete inquiry error:", e);
    }
  }
}

// ===================================================================
// PROJECTS MANAGEMENT
// ===================================================================

async function loadProjects() {
  try {
    const res = await fetch("/api/projects?all=true");
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.projects) {
        projectsList = data.projects;
      }
    }
  } catch (e) {
    console.error("Failed to load projects:", e);
  }
  updateProjectStats();
  renderProjectTable();
}

function updateProjectStats() {
  const published = projectsList.filter(p => p.status === "published");
  const drafts = projectsList.filter(p => p.status === "draft");

  let totalMedia = 0;
  projectsList.forEach(p => {
    if (p.images) totalMedia += p.images.length;
  });

  const totProjEl = document.getElementById("stat-total-projects");
  if (totProjEl) totProjEl.textContent = projectsList.length;

  const pubProjEl = document.getElementById("stat-published-projects");
  if (pubProjEl) pubProjEl.textContent = published.length;

  const mediaEl = document.getElementById("stat-total-media");
  if (mediaEl) mediaEl.textContent = totalMedia;
}

function renderProjectTable() {
  const tbody = document.getElementById("admin-projects-tbody");
  if (!tbody) return;

  let list = projectsList;

  if (currentProjectFilter !== "all") {
    list = list.filter(p => p.status === currentProjectFilter);
  }

  if (adminSearchQuery.trim() !== "") {
    const q = adminSearchQuery.toLowerCase();
    list = list.filter(p =>
      p.title.toLowerCase().includes(q) ||
      p.location.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q)
    );
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:#94a3b8;">No projects found.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(p => {
    const imgCount = p.images ? p.images.length : 0;
    const statusClass = p.status || "published";

    return `
      <tr>
        <td>
          <div class="table-proj-info">
            <img src="${p.coverImage || '/logo.png'}" class="table-thumb" alt="${p.title}">
            <div>
              <div style="font-weight:600;color:var(--admin-text-main);">${p.title}</div>
              <div style="font-size:0.78rem;color:var(--admin-text-sub);">${p.slug}</div>
            </div>
          </div>
        </td>
        <td><span style="font-weight:600;color:var(--admin-gold);">${p.category}</span></td>
        <td><span style="color:var(--admin-text-sub);">${p.eventDate || '—'}</span></td>
        <td>
          <button class="act-btn" onclick="openMediaManager('${p.id}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <circle cx="8.5" cy="8.5" r="1.5"></circle>
              <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
            <span>${imgCount} Photos</span>
          </button>
        </td>
        <td><span class="status-badge ${statusClass}">${p.status}</span></td>
        <td>
          <div class="action-btn-group">
            <a href="/project?slug=${p.slug}" target="_blank" class="act-btn" title="View Public Album">
              👁️ View
            </a>
            <button class="act-btn" title="Edit Metadata" onclick="openEditProjectModal('${p.id}')">
              ✏️ Edit
            </button>
            <button class="act-btn" title="Toggle Status" onclick="toggleProjectStatus('${p.id}', '${p.status}')">
              ${p.status === 'published' ? 'Draft' : 'Publish'}
            </button>
            <button class="act-btn delete" title="Delete" onclick="deleteProjectPrompt('${p.id}')">
              🗑️
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

// Bind UI events
function bindEvents() {
  // Inquiry filter pills
  document.querySelectorAll(".inq-pill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".inq-pill-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentInquiryFilter = btn.dataset.status;
      renderInquiriesTable();
    });
  });

  // Project filter pills
  document.querySelectorAll(".proj-pill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".proj-pill-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentProjectFilter = btn.dataset.status;
      renderProjectTable();
    });
  });

  // Search input
  const searchInput = document.getElementById("admin-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      adminSearchQuery = e.target.value;
      renderProjectTable();
    });
  }

  // Project modal form
  const projForm = document.getElementById("project-form");
  if (projForm) {
    projForm.addEventListener("submit", (e) => {
      e.preventDefault();
      saveProjectHandler();
    });
  }

  // Add image form
  const addImgForm = document.getElementById("add-image-form");
  if (addImgForm) {
    addImgForm.addEventListener("submit", (e) => {
      e.preventDefault();
      addImageHandler();
    });
  }
}

// Modal open/close
function openCreateProjectModal() {
  activeEditingProjectId = null;
  document.getElementById("modal-project-title-text").textContent = "Create New Event Project";
  document.getElementById("project-form").reset();
  document.getElementById("f-project-id").value = "";
  document.body.style.overflow = "hidden";
  document.getElementById("project-modal").classList.add("active");
}

function openEditProjectModal(id) {
  activeEditingProjectId = id;
  const proj = projectsList.find(p => p.id === id);
  if (!proj) return;

  document.getElementById("modal-project-title-text").textContent = "Edit Project Metadata";
  document.getElementById("f-project-id").value = proj.id;
  document.getElementById("f-title").value = proj.title;
  document.getElementById("f-slug").value = proj.slug;
  document.getElementById("f-category").value = proj.category;
  document.getElementById("f-date").value = proj.eventDate || "";
  document.getElementById("f-location").value = proj.location || "";
  document.getElementById("f-client").value = proj.client || "";
  document.getElementById("f-attendees").value = proj.attendees || "";
  document.getElementById("f-cover").value = proj.coverImage || "";
  document.getElementById("f-desc").value = proj.description || "";
  document.getElementById("f-status").value = proj.status || "published";
  document.getElementById("f-featured").checked = !!proj.featured;

  document.body.style.overflow = "hidden";
  document.getElementById("project-modal").classList.add("active");
}

function closeProjectModal() {
  document.body.style.overflow = "";
  document.getElementById("project-modal").classList.remove("active");
}

async function saveProjectHandler() {
  const id = document.getElementById("f-project-id").value;
  const title = document.getElementById("f-title").value.trim();
  const slug = document.getElementById("f-slug").value.trim();
  const category = document.getElementById("f-category").value;
  const eventDate = document.getElementById("f-date").value;
  const location = document.getElementById("f-location").value.trim();
  const client = document.getElementById("f-client").value.trim();
  const attendees = document.getElementById("f-attendees").value.trim();
  const coverImage = document.getElementById("f-cover").value.trim() || "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80";
  const description = document.getElementById("f-desc").value.trim();
  const status = document.getElementById("f-status").value;
  const featured = document.getElementById("f-featured").checked;

  const payload = {
    title,
    slug: slug || title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    category,
    eventDate,
    location,
    client,
    attendees,
    coverImage,
    description,
    status,
    featured
  };

  const isEdit = !!id;
  const url = isEdit ? `/api/projects/${id}` : `/api/projects`;
  const method = isEdit ? "PUT" : "POST";

  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      closeProjectModal();
      await loadProjects();
      alert("Project saved successfully!");
    } else {
      alert(data.error || "Failed to save project.");
    }
  } catch (e) {
    console.error("Save error:", e);
    alert("Network error saving project.");
  }
}

async function toggleProjectStatus(id, currentStatus) {
  const newStatus = currentStatus === "published" ? "draft" : "published";
  try {
    const res = await fetch(`/api/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus })
    });
    if (res.ok) {
      await loadProjects();
    }
  } catch (e) {
    console.error("Status toggle error:", e);
  }
}

async function deleteProjectPrompt(id) {
  if (confirm("Are you sure you want to delete this project album?")) {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (res.ok) {
        await loadProjects();
      }
    } catch (e) {
      console.error("Delete error:", e);
    }
  }
}

// Media Manager
function openMediaManager(projectId) {
  activeGalleryProjectId = projectId;
  const proj = projectsList.find(p => p.id === projectId);
  if (!proj) return;

  document.getElementById("gallery-modal-proj-name").textContent = proj.title;
  renderMediaGallery(proj);
  document.body.style.overflow = "hidden";
  document.getElementById("media-modal").classList.add("active");
}

function closeMediaModal() {
  document.body.style.overflow = "";
  document.getElementById("media-modal").classList.remove("active");
  loadProjects();
}

function renderMediaGallery(proj) {
  const container = document.getElementById("modal-gallery-container");
  const images = proj.images || [];

  if (images.length === 0) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:24px;color:#94a3b8;">No photos uploaded yet for this project.</div>`;
    return;
  }

  container.innerHTML = images.map((img, i) => `
    <div class="modal-gallery-card">
      <img src="${img.thumbnailUrl || img.url}" alt="${img.caption || 'Photo'}">
      <button class="modal-gallery-del" title="Delete Photo" onclick="deleteImageHandler('${proj.id}', '${img.id}')">✕</button>
      <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.78);padding:6px 8px;color:#fff;font-size:0.7rem;display:flex;justify-content:space-between;align-items:center;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;">${img.caption || `Photo ${i + 1}`}</span>
        ${img.url && img.url.includes("r2.dev") ? '<span style="background:#059669;color:#fff;padding:1px 5px;border-radius:4px;font-size:0.65rem;font-weight:700;">☁️ R2</span>' : ''}
      </div>
    </div>
  `).join("");
}

// Upload Cover image directly to Cloudflare R2
async function uploadCoverToR2(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const statusEl = document.getElementById("cover-r2-status");
  const coverInput = document.getElementById("f-cover");

  if (statusEl) {
    statusEl.style.display = "block";
    statusEl.style.color = "#0284c7";
    statusEl.textContent = `⏳ Uploading "${file.name}" to Cloudflare R2 Bucket (hkevent)...`;
  }

  const formData = new FormData();
  formData.append("image", file);
  formData.append("folder", "covers");

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData
    });
    const data = await res.json();

    if (data.success && data.url) {
      coverInput.value = data.url;
      if (statusEl) {
        statusEl.style.color = "#059669";
        statusEl.innerHTML = `✓ Uploaded to Cloudflare R2: <a href="${data.url}" target="_blank" style="color:#059669;text-decoration:underline;">View R2 File</a>`;
      }
    } else {
      throw new Error(data.error || "Upload failed");
    }
  } catch (err) {
    console.error("Cover upload error:", err);
    if (statusEl) {
      statusEl.style.color = "#dc2626";
      statusEl.textContent = `✕ Cloudflare R2 upload error: ${err.message}`;
    }
  }
}

// Upload photos directly to Cloudflare R2 for the active Project
async function handleFileUpload(input) {
  if (!input.files || !input.files[0] || !activeGalleryProjectId) return;
  const files = Array.from(input.files);
  const container = document.getElementById("modal-gallery-container");

  // Create or get status banner
  let statusBanner = document.getElementById("r2-upload-status");
  if (!statusBanner) {
    statusBanner = document.createElement("div");
    statusBanner.id = "r2-upload-status";
    statusBanner.style = "background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:0.85rem;display:flex;align-items:center;gap:10px;";
    container.parentNode.insertBefore(statusBanner, container);
  }

  statusBanner.style.display = "flex";
  statusBanner.style.background = "#eff6ff";
  statusBanner.style.borderColor = "#bfdbfe";
  statusBanner.style.color = "#1e40af";
  statusBanner.innerHTML = `<span>⏳</span> <span>Uploading <strong>${files.length}</strong> photo(s) directly to <strong>Cloudflare R2 (hkevent)</strong> & Firestore...</span>`;

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      formData.append("image", file);
      formData.append("caption", file.name.replace(/\.[^/.]+$/, ""));

      statusBanner.innerHTML = `<span>⏳</span> <span>Uploading (${i + 1}/${files.length}): <em>${file.name}</em> to Cloudflare R2...</span>`;

      const res = await fetch(`/api/projects/${activeGalleryProjectId}/images`, {
        method: "POST",
        body: formData
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to upload to Cloudflare R2");
      }
    }

    statusBanner.style.background = "#ecfdf5";
    statusBanner.style.borderColor = "#a7f3d0";
    statusBanner.style.color = "#065f46";
    statusBanner.innerHTML = `<span>✓</span> <span><strong>Success!</strong> All photos uploaded to <strong>Cloudflare R2</strong> and saved to <strong>Firestore</strong>!</span>`;

    setTimeout(() => {
      if (statusBanner) statusBanner.style.display = "none";
    }, 4000);

    input.value = "";
    await loadProjects();
    const proj = projectsList.find(p => p.id === activeGalleryProjectId);
    if (proj) renderMediaGallery(proj);
  } catch (err) {
    console.error("Gallery upload error:", err);
    statusBanner.style.background = "#fef2f2";
    statusBanner.style.borderColor = "#fecaca";
    statusBanner.style.color = "#991b1b";
    statusBanner.innerHTML = `<span>✕</span> <span>Upload error: ${err.message}</span>`;
  }
}

async function addImageHandler() {
  if (!activeGalleryProjectId) return;
  const urlInput = document.getElementById("img-upload-url");
  const captionInput = document.getElementById("img-upload-caption");

  const url = urlInput.value.trim();
  const caption = captionInput.value.trim();

  if (!url) {
    alert("Please provide an image URL or choose a file to upload.");
    return;
  }

  try {
    const res = await fetch(`/api/projects/${activeGalleryProjectId}/images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, caption })
    });
    const data = await res.json();

    if (data.success) {
      urlInput.value = "";
      captionInput.value = "";
      await loadProjects();
      const proj = projectsList.find(p => p.id === activeGalleryProjectId);
      if (proj) renderMediaGallery(proj);
    }
  } catch (e) {
    console.error("Add image error:", e);
  }
}

async function deleteImageHandler(projectId, imageId) {
  if (confirm("Delete this photo from album and Cloudflare R2 bucket?")) {
    try {
      const res = await fetch(`/api/projects/${projectId}/images/${imageId}`, { method: "DELETE" });
      if (res.ok) {
        await loadProjects();
        const proj = projectsList.find(p => p.id === projectId);
        if (proj) renderMediaGallery(proj);
      }
    } catch (e) {
      console.error("Delete photo error:", e);
    }
  }
}
