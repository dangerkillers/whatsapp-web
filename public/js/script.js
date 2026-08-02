/**
 * =============================================================
 *  WhatsApp Pairing Website - script.js (client-side)
 * =============================================================
 *  Handles:
 *   - Connecting to the Socket.IO server
 *   - Submitting the phone number to request a pairing code
 *   - Rendering live status updates (connecting/waiting/connected/error)
 *   - Displaying the pairing code or QR code fallback
 *   - Copy-to-clipboard and "pair another device" reset flow
 * =============================================================
 */

(() => {
  'use strict';

  // Establish the Socket.IO connection to our own server
  const socket = io();

  // ------------------------------------------------------------
  // Cache DOM references
  // ------------------------------------------------------------
  const phoneInput = document.getElementById('phone-input');
  const generateBtn = document.getElementById('generate-btn');
  const btnSpinner = document.getElementById('btn-spinner');
  const btnText = generateBtn.querySelector('.btn-text');

  const inputSection = document.getElementById('input-section');
  const statusRow = document.getElementById('status-row');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  const pairCodeSection = document.getElementById('pair-code-section');
  const pairCodeEl = document.getElementById('pair-code');
  const copyBtn = document.getElementById('copy-btn');

  const qrSection = document.getElementById('qr-section');
  const qrImage = document.getElementById('qr-image');

  const connectedSection = document.getElementById('connected-section');
  const resetBtn = document.getElementById('reset-btn');

  // ------------------------------------------------------------
  // Helper: reset the UI back to its initial state
  // ------------------------------------------------------------
  function resetUI() {
    inputSection.hidden = false;
    statusRow.hidden = true;
    pairCodeSection.hidden = true;
    qrSection.hidden = true;
    connectedSection.hidden = true;

    generateBtn.disabled = false;
    btnSpinner.hidden = true;
    btnText.textContent = 'Generate Pair Code';

    phoneInput.value = '';
    pairCodeEl.textContent = '----\u2011----';
  }

  // ------------------------------------------------------------
  // Helper: update the status row (dot color + message)
  // ------------------------------------------------------------
  function setStatus(state, message) {
    statusRow.hidden = false;
    statusDot.className = 'status-dot ' + cssClassForState(state);
    statusText.textContent = message;
  }

  function cssClassForState(state) {
    switch (state) {
      case 'connecting':
        return 'connecting';
      case 'waiting_for_pair':
        return 'waiting';
      case 'connected':
        return 'connected';
      case 'error':
        return 'error';
      default:
        return '';
    }
  }

  // ------------------------------------------------------------
  // Basic client-side validation before submitting
  // ------------------------------------------------------------
  function isValidPhoneNumber(value) {
    const digitsOnly = value.replace(/[^0-9]/g, '');
    return digitsOnly.length >= 8 && digitsOnly.length <= 15;
  }

  // ------------------------------------------------------------
  // "Generate Pair Code" button handler
  // ------------------------------------------------------------
  generateBtn.addEventListener('click', () => {
    const value = phoneInput.value.trim();

    if (!isValidPhoneNumber(value)) {
      setStatus('error', 'Enter a valid phone number with country code (8-15 digits).');
      phoneInput.focus();
      return;
    }

    // UI: show loading state on the button
    generateBtn.disabled = true;
    btnSpinner.hidden = false;
    btnText.textContent = 'Generating...';

    // Hide any previous results
    pairCodeSection.hidden = true;
    qrSection.hidden = true;
    connectedSection.hidden = true;

    setStatus('connecting', 'Connecting to WhatsApp servers...');

    socket.emit('generate-pair-code', { phoneNumber: value });
  });

  // Allow pressing "Enter" inside the phone field to submit
  phoneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      generateBtn.click();
    }
  });

  // ------------------------------------------------------------
  // Socket.IO event listeners (server -> client)
  // ------------------------------------------------------------

  // General status updates (connecting / waiting / connected / error)
  socket.on('status', ({ state, message }) => {
    setStatus(state, message);

    if (state === 'connected') {
      generateBtn.disabled = false;
      btnSpinner.hidden = true;
      btnText.textContent = 'Generate Pair Code';
    }

    if (state === 'error') {
      generateBtn.disabled = false;
      btnSpinner.hidden = true;
      btnText.textContent = 'Generate Pair Code';
    }
  });

  // Pairing code received from the server
  socket.on('pair-code', ({ code, formatted }) => {
    pairCodeEl.textContent = formatted || code;
    pairCodeSection.hidden = false;
    qrSection.hidden = true; // pairing code takes priority over QR
    generateBtn.disabled = false;
    btnSpinner.hidden = true;
    btnText.textContent = 'Generate Pair Code';
  });

  // QR code fallback (only shown if a pairing code wasn't available)
  socket.on('qr-code', ({ qrDataUrl }) => {
    // Only show QR if we don't already have a pairing code on screen
    if (pairCodeSection.hidden) {
      qrImage.src = qrDataUrl;
      qrSection.hidden = false;
    }
  });

  // Successfully linked
  socket.on('connected', () => {
    pairCodeSection.hidden = true;
    qrSection.hidden = true;
    connectedSection.hidden = false;
  });

  // ------------------------------------------------------------
  // Copy pairing code to clipboard
  // ------------------------------------------------------------
  copyBtn.addEventListener('click', async () => {
    const rawCode = pairCodeEl.textContent.replace(/\u2011/g, '-');
    try {
      await navigator.clipboard.writeText(rawCode);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy Code'), 1500);
    } catch (err) {
      console.error('Clipboard copy failed:', err);
      copyBtn.textContent = 'Copy failed';
      setTimeout(() => (copyBtn.textContent = 'Copy Code'), 1500);
    }
  });

  // ------------------------------------------------------------
  // "Pair Another Device" resets everything for a new attempt
  // ------------------------------------------------------------
  resetBtn.addEventListener('click', () => {
    socket.emit('cancel-session');
    resetUI();
  });

  // ------------------------------------------------------------
  // Handle underlying socket connection issues gracefully
  // ------------------------------------------------------------
  socket.on('connect_error', () => {
    setStatus('error', 'Cannot reach the server. Please check your connection.');
  });
})();
