// ═══════════════════════════════════════════════════════════════════════════════
// FILE: icons/generate-icons.js
// PURPOSE: Generates PNG icon files for the extension using the Canvas API.
//          Run this script ONCE in a browser console or Node.js + canvas package.
//
// HOW TO RUN (easiest way — browser console):
//   1. Open any webpage in Chrome
//   2. Open DevTools (F12) → Console tab
//   3. Paste this entire script and press Enter
//   4. Icons will be downloaded automatically
//   5. Move the downloaded PNG files to the icons/ folder
//
// ALTERNATIVE: Use any image editor to create 3 PNG files:
//   icon16.png  (16x16 pixels)
//   icon48.png  (48x48 pixels)
//   icon128.png (128x128 pixels)
// ═══════════════════════════════════════════════════════════════════════════════

// drawIcon() creates a single icon at a given size and downloads it
function drawIcon(size) {
  // Create an in-memory canvas element (not added to the page)
  const canvas = document.createElement('canvas');
  canvas.width  = size;  // Set canvas pixel width
  canvas.height = size;  // Set canvas pixel height

  // Get the 2D drawing context — all drawing commands go through this object
  const ctx = canvas.getContext('2d');

  // ── Background circle ──────────────────────────────────────────────────────
  // Arc path for a circle: arc(centerX, centerY, radius, startAngle, endAngle)
  // Math.PI * 2 = full circle (360 degrees in radians)
  ctx.beginPath();
  ctx.arc(size/2, size/2, size/2, 0, Math.PI * 2);

  // Gradient fill: dark blue to lighter blue (diagonal top-left to bottom-right)
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#0a66c2'); // LinkedIn blue at top-left
  gradient.addColorStop(1, '#0d47a1'); // Darker blue at bottom-right
  ctx.fillStyle = gradient;
  ctx.fill(); // Fill the circle path

  // ── Center letter "AI" or just "A" ────────────────────────────────────────
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';       // Horizontal center
  ctx.textBaseline = 'middle';    // Vertical center

  // Font size scales with icon size (40% of total size)
  ctx.font = `bold ${Math.floor(size * 0.4)}px -apple-system, Arial, sans-serif`;

  // Draw text at the center of the canvas
  ctx.fillText('AI', size/2, size/2);

  // ── Small indicator dot (bottom-right) ──────────────────────────────────────
  // Green dot shows the extension is "active"
  if (size >= 48) { // Only for larger icons
    ctx.beginPath();
    ctx.arc(size * 0.78, size * 0.78, size * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = '#22c55e'; // Green
    ctx.fill();
    // White ring around the dot
    ctx.strokeStyle = 'white';
    ctx.lineWidth = size * 0.04;
    ctx.stroke();
  }

  // ── Export as PNG and download ─────────────────────────────────────────────
  // canvas.toDataURL() returns the canvas content as a base64-encoded PNG data URL
  const dataUrl = canvas.toDataURL('image/png');

  // Create a temporary <a> link and click it to trigger download
  const link      = document.createElement('a');
  link.href       = dataUrl;
  link.download   = `icon${size}.png`; // Filename like "icon48.png"
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  console.log(`Downloaded icon${size}.png`);
}

// Generate all three required sizes
drawIcon(16);   // 16x16 — used in browser toolbar/favicon
drawIcon(48);   // 48x48 — used in extension management page
drawIcon(128);  // 128x128 — used in Chrome Web Store

console.log('All icons generated! Move them to the icons/ folder.');
