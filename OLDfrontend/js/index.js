document.addEventListener('DOMContentLoaded', function () {
    const navLinks = document.querySelectorAll('.nav-item .nav-link');
    const sections = document.querySelectorAll('section');
    const homeElement = document.getElementById('page-top');

    navLinks.forEach(function (link) {
        link.addEventListener('click', function () {
            navLinks.forEach(function (item) {
                item.classList.remove('active');
            });
            this.classList.add('active');
        });
    });

    window.addEventListener('scroll', function () {
        let scrollPosition = window.pageYOffset || document.documentElement.scrollTop;
        let currentActiveId = null;

        if (homeElement && scrollPosition < (sections.length > 0 ? sections[0].offsetTop / 2 : 100)) {
            currentActiveId = 'page-top';
        } else {
            sections.forEach(function (section) {
                const sectionTop = section.offsetTop;
                const sectionHeight = section.offsetHeight;

                if (scrollPosition >= sectionTop - sectionHeight * 0.5 &&
                    scrollPosition < sectionTop + sectionHeight * 0.5) {
                    currentActiveId = section.getAttribute('id');
                }
            });
        }

        if ((window.innerHeight + scrollPosition) >= document.body.offsetHeight - 50 && sections.length > 0) {
            const lastSection = sections[sections.length - 1];
            const lastSectionTop = lastSection.offsetTop;
            const lastSectionHeight = lastSection.offsetHeight;
            if (scrollPosition >= lastSectionTop - lastSectionHeight * 0.5) {
                currentActiveId = lastSection.getAttribute('id');
            }
        }


        navLinks.forEach(function (link) {
            link.classList.remove('active');
            const href = link.getAttribute('href');
            if (href && href.startsWith('#') && href.substring(1) === currentActiveId) {
                link.classList.add('active');
            }
        });

        if (!currentActiveId && scrollPosition < 50) {
            const homeLink = document.querySelector('.nav-item .nav-link[href="#page-top"]');
            if (homeLink) {
                let otherActive = false;
                navLinks.forEach(l => { if (l !== homeLink && l.classList.contains('active')) otherActive = true; });
                if (!otherActive) homeLink.classList.add('active');
            }
        }
    });

    function setInitialActiveLink() {
        const hash = window.location.hash;
        let activeSet = false;
        if (hash) {
            navLinks.forEach(link => {
                if (link.getAttribute('href') === hash) {
                    link.classList.add('active');
                    activeSet = true;
                } else {
                    link.classList.remove('active');
                }
            });
        }

        if (!activeSet) {
            const homeLink = document.querySelector('.nav-item .nav-link[href="#page-top"]');
            if (homeLink) {
                navLinks.forEach(link => link.classList.remove('active'));
                homeLink.classList.add('active');
            }
            setTimeout(() => window.dispatchEvent(new Event('scroll')), 100);
        } else {
            setTimeout(() => window.dispatchEvent(new Event('scroll')), 100);
        }
    }
    setInitialActiveLink();
});