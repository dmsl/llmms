// Alpine.js Component for contact form on index.html
function contactForm() {
    return {
        formData: {
            name: '',
            email: '',
            message: ''
        },
        message: '',
        success: false,
        
        async submitForm() {
            if (!this.formData.name || !this.formData.email || !this.formData.message) {
                this.message = 'All fields are required.';
                this.success = false;
                return;
            }
            
            try {
                const response = await fetch('/submit-form', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.formData)
                });
                
                if (response.ok) {
                    this.message = 'Form submitted successfully!';
                    this.success = true;
                    this.formData = { name: '', email: '', message: '' };
                } else {
                    this.message = 'Failed to submit the form. Please try again.';
                    this.success = false;
                }
            } catch (error) {
                console.error('Error:', error);
                this.message = 'An error occurred. Please try again later.';
                this.success = false;
            }
            
            // Clear message after 5 seconds
            setTimeout(() => {
                this.message = '';
            }, 5000);
        }
    }
}
