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
    const closeButton = document.getElementById('closeWriteModal');

    if (!modal || !pathElement || !previewElement || !allowButton || !denyButton || !closeButton) {
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
    const newCloseButton = closeButton.cloneNode(true);
    allowButton.parentNode.replaceChild(newAllowButton, allowButton);
    denyButton.parentNode.replaceChild(newDenyButton, denyButton);
    closeButton.parentNode.replaceChild(newCloseButton, closeButton);

    let settled = false;
    let previousOverflow = '';

    const cleanup = () => {
      document.removeEventListener('keydown', handleKeydown);
      modal.removeEventListener('click', handleOverlayClick);
      document.body.style.overflow = previousOverflow;
      modal.hidden = true;
    };

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleKeydown = (event) => {
      if (event.key === 'Escape') {
        finish(false);
      }
    };

    const handleOverlayClick = (event) => {
      if (event.target === modal) {
        finish(false);
      }
    };

    // Set up handlers
    newAllowButton.onclick = () => {
      finish(true);
    };

    newDenyButton.onclick = () => {
      finish(false);
    };

    newCloseButton.onclick = () => {
      finish(false);
    };

    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modal.hidden = false;
    document.addEventListener('keydown', handleKeydown);
    modal.addEventListener('click', handleOverlayClick);
  });
}
