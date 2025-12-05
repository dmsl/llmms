/**
 * File Write Permission Handler
 * 
 * Displays a confirmation modal for file write operations in Electron mode.
 * Web mode does not use this.
 */

export async function confirmWrite(path, content) {
  return new Promise((resolve) => {
    const modal = document.getElementById('writeConfirmModal');
    const pathElement = document.getElementById('write-path');
    const previewElement = document.getElementById('write-preview');
    const allowButton = document.getElementById('allowWrite');
    const denyButton = document.getElementById('denyWrite');

    if (!modal || !pathElement || !previewElement || !allowButton || !denyButton) {
      console.error('Permission modal elements not found');
      resolve(false);
      return;
    }

    // Populate modal content
    pathElement.textContent = `File: ${path}`;
    const preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
    previewElement.textContent = preview;

    // Clear previous handlers to avoid duplicate listeners
    const newAllowButton = allowButton.cloneNode(true);
    const newDenyButton = denyButton.cloneNode(true);
    allowButton.parentNode.replaceChild(newAllowButton, allowButton);
    denyButton.parentNode.replaceChild(newDenyButton, denyButton);

    // Set up handlers
    newAllowButton.onclick = () => {
      bootstrap.Modal.getInstance(modal).hide();
      resolve(true);
    };

    newDenyButton.onclick = () => {
      bootstrap.Modal.getInstance(modal).hide();
      resolve(false);
    };

    // Show modal
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();
  });
}
