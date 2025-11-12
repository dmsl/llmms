# Quick Setup Guide - Modern Frontend

## Instant Start (No Installation) 🚀

1. **Open in Browser**
   ```
   http://localhost/html/llmms-modern.html
   ```
   
   That's it! Everything loads from CDN. No installation needed.

## Test All Features

### ✓ Basic Chat
1. Type a message in the input box
2. Press Enter or click send button
3. Watch the streaming response

### ✓ Model Selection
1. Click the model dropdown (bottom left)
2. Select "LLM-MS-OUA" or "LLM-MS-MAB"
3. Model updates instantly

### ✓ Settings Panel
1. Click the settings icon (bottom right)
2. Adjust token budget with slider
3. Modify alpha/beta weights
4. Click "Save Settings"

### ✓ Sessions
1. Click "New Chat" to create session
2. Switch between sessions in sidebar
3. Click "Clear All" to reset

### ✓ Responsive Design
1. Resize browser window
2. Check mobile view (< 768px)
3. Sidebar slides out on mobile

## Optional: Production Build

For minimal file size (~10KB CSS):

```bash
cd frontend

# Install (one-time)
npm install

# Build
npm run build:css

# Output: dist/output.css
```

Then update `llmms-modern.html`:
```html
<!-- Replace CDN line with: -->
<link href="/dist/output.css" rel="stylesheet">
```

## Customize Colors

Edit the Tailwind config in `<script>` section:

```javascript
tailwind.config = {
    theme: {
        extend: {
            colors: {
                primary: {
                    DEFAULT: '#6a42c2',  // Change this!
                    light: '#8b6dd4',
                    dark: '#4a2c82',
                    pale: '#f2f0f6'
                }
            }
        }
    }
}
```

## Deploy to Production

### Method 1: Simple Replace
```bash
# Backup original
cp html/llmms.html html/llmms-legacy.html

# Deploy modern version
cp html/llmms-modern.html html/llmms.html
```

### Method 2: Apache Alias
```apache
# In Apache config
Alias /chat /path/to/llmms/frontend/html/llmms-modern.html
```

### Method 3: Gradual Rollout
```apache
# Route 10% of traffic to modern version
RewriteEngine On
RewriteCond expr "rand() < 0.1"
RewriteRule ^/llmms.html$ /llmms-modern.html [L]
```

## Verify Installation

### 1. Check Console
Open DevTools Console (F12):
```javascript
// Should see Alpine loaded
console.log(Alpine.version); // "3.x.x"

// Should see Tailwind working
document.querySelector('[class*="bg-primary"]'); // Found
```

### 2. Check Network
Network tab should show:
- ✅ alpinejs (~15KB)
- ✅ tailwindcss (~10KB)
- ✅ fontawesome icons
- ✅ API calls to /api/send_message_llmms

### 3. Check Performance
```javascript
// Lighthouse score should be:
Performance: 95+ ✅
Accessibility: 95+ ✅
Best Practices: 90+ ✅
SEO: 90+ ✅
```

## Troubleshooting

### Problem: Blank Page
**Solution**: Check console for errors. Ensure CDN scripts load:
```html
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
```

### Problem: Styles Missing
**Solution**: Verify Tailwind script:
```html
<script src="https://cdn.tailwindcss.com"></script>
```

### Problem: API Errors
**Solution**: Check Apache proxy:
```bash
sudo tail -f /var/log/apache2/error.log
```

### Problem: Sidebar Won't Open
**Solution**: Check Alpine is initialized:
```javascript
// In console:
document.querySelector('[x-data]').__x.$data.sidebarOpen = true;
```

## Performance Checklist

- [ ] Page loads in < 1 second
- [ ] No console errors
- [ ] Streaming responses work
- [ ] Mobile layout responsive
- [ ] Settings persist in sessionStorage
- [ ] All buttons clickable

## Browser Testing

Test in multiple browsers:
- [ ] Chrome (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest)
- [ ] Edge (latest)
- [ ] Mobile Safari (iOS)
- [ ] Chrome Mobile (Android)

## Next Steps

1. ✅ Test modern version thoroughly
2. ✅ Compare with original version
3. ✅ Get user feedback
4. ✅ Deploy to production
5. ✅ Update documentation
6. ✅ Archive legacy code

## Need Help?

- 📖 Read `FRONTEND_MIGRATION.md` for details
- 📊 Check `STACK_COMPARISON.md` for analysis
- 📝 See `.github/copilot-instructions.md` for architecture
- 📧 Contact: dzeina@cs.ucy.ac.cy

---

**Ready to go!** No installation required. Just open and test! 🎉
