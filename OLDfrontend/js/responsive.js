document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('sidebar');
    const toggleButton = document.getElementById('toggle-sidebar');
    const rightside = document.getElementById('rightside');

    // Update layout based on viewport width
    function updateLayout() {
        if (window.innerWidth < 768) {
            // MOBILE MODE: add mobile-specific classes and set default state
            sidebar.classList.add('mobile');
            rightside.classList.add('mobile');

            // Set mobile default: both sidebar and rightside are collapsed
            sidebar.classList.remove('expanded');
            sidebar.classList.add('collapsed');
            rightside.classList.remove('expanded');
            rightside.classList.add('collapsed');
        } else {
            // DESKTOP MODE: remove mobile-specific classes
            sidebar.classList.remove('mobile', 'expanded', 'collapsed');
            rightside.classList.remove('mobile', 'expanded', 'collapsed');

            // Desktop default state: sidebar collapsed (overlay mode)
            sidebar.classList.add('collapsed');
        }
    }

    window.addEventListener('resize', updateLayout);
    window.addEventListener('load', updateLayout);
    updateLayout();


    // Toggle button click triggers the sidebar state change only.
    toggleButton.addEventListener('click', () => {
        if (window.innerWidth < 768) {
            // MOBILE: Toggle sidebar and rightside states.
            if (sidebar.classList.contains('collapsed')) {
                sidebar.classList.remove('collapsed');
                sidebar.classList.add('expanded');
                rightside.classList.remove('collapsed');
                rightside.classList.add('expanded');
            } else {
                sidebar.classList.remove('expanded');
                sidebar.classList.add('collapsed');
                rightside.classList.remove('expanded');
                rightside.classList.add('collapsed');
            }
        } else {
            // DESKTOP: Toggle sidebar overlay only.
            if (sidebar.classList.contains('collapsed')) {
                sidebar.classList.remove('collapsed');
                sidebar.classList.add('expanded');
            } else {
                sidebar.classList.remove('expanded', 'partial-shadow');
                sidebar.classList.add('collapsed');
            }
        }

    });

    function focusTextbox() {
        const userInput = document.getElementById('user-input');
        if (userInput) {
            userInput.focus();
        }
    }
});





const textarea = document.getElementById("user-input");
// const tetxtareacontainer = document.getElementById("chat-input-container");
textarea.addEventListener("input", function () {
    this.style.height = "auto"; // Reset the height
    const lineHeight = parseInt(window.getComputedStyle(this).lineHeight, 10) || 24;
    const maxHeight = lineHeight * 7; // 7 lines maximum
    if (this.scrollHeight > maxHeight) {
        this.style.height = maxHeight + "px";
        this.style.overflowY = "scroll";
        // tetxtareacontainer.style.height = maxHeight + "px";
    } else {
        this.style.height = this.scrollHeight + "px";
        this.style.overflowY = "hidden";
        // tetxtareacontainer.style.height = this.scrollHeight + "px";

    }
    
});
