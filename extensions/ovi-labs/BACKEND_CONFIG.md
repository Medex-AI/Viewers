# OVI Labs Backend Configuration

## Current Setup (Hardcoded)

The segmentation backend URL is currently hardcoded to `http://localhost:8000`.

### Configuration Priority

1. **Environment Variable** (highest priority)
   ```bash
   # In frontend/.env.local
   REACT_APP_SEGMENTATION_API_URL=http://localhost:8000
   ```

2. **Default Fallback**
   - If no environment variable is set, defaults to `http://localhost:8000`

### Changing the Backend URL

#### Option 1: Environment Variable (Recommended for Dev)

Create or edit `frontend/.env.local`:
```bash
# Development
REACT_APP_SEGMENTATION_API_URL=http://localhost:8000

# Production
# REACT_APP_SEGMENTATION_API_URL=https://segmentation-api.medex.example.com
```

Restart the dev server after changing `.env.local`:
```bash
cd frontend
yarn dev
```

#### Option 2: Programmatic (For Future User Preferences)

```typescript
import { setSegmentationBackendUrl } from '../services/segmentationApi';

// Set custom URL
setSegmentationBackendUrl('http://custom-server:8000');

// Reset to default
resetSegmentationBackendUrl();

// Get current URL
const currentUrl = getSegmentationBackendUrl();
```

## Future: User Preferences Integration

### TODO: Add to OVI Labs Preferences Panel

When implementing user preferences, follow this pattern:

#### 1. Add Preference Field

Create/update preferences panel component:

```typescript
// frontend/extensions/ovi-labs/src/components/PreferencesPanel.tsx

import { setSegmentationBackendUrl, getSegmentationBackendUrl } from '../services/segmentationApi';

const PreferencesPanel = () => {
  const [backendUrl, setBackendUrl] = useState(getSegmentationBackendUrl());

  const handleSave = () => {
    setSegmentationBackendUrl(backendUrl);
    localStorage.setItem('ovi-labs-backend-url', backendUrl);
    // Show success notification
  };

  const handleReset = () => {
    const defaultUrl = 'http://localhost:8000';
    setBackendUrl(defaultUrl);
    setSegmentationBackendUrl(defaultUrl);
    localStorage.removeItem('ovi-labs-backend-url');
  };

  return (
    <div className="preferences-section">
      <h3>Segmentation Backend</h3>
      <label>
        Backend URL:
        <input
          type="url"
          value={backendUrl}
          onChange={(e) => setBackendUrl(e.target.value)}
          placeholder="http://localhost:8000"
        />
      </label>
      <button onClick={handleSave}>Save</button>
      <button onClick={handleReset}>Reset to Default</button>
    </div>
  );
};
```

#### 2. Load Preference on Extension Init

```typescript
// frontend/extensions/ovi-labs/src/index.tsx

import { setSegmentationBackendUrl } from './services/segmentationApi';

function OviLabsExtension() {
  // Load saved backend URL from localStorage
  useEffect(() => {
    const savedUrl = localStorage.getItem('ovi-labs-backend-url');
    if (savedUrl) {
      setSegmentationBackendUrl(savedUrl);
    }
  }, []);

  // ... rest of extension
}
```

#### 3. Add Preferences Button to Panel

Add a gear icon button to the OVI Labs panel that opens the preferences modal:

```typescript
// In SegmentationPanel or OVI Labs main panel

<button
  onClick={() => setPreferencesOpen(true)}
  title="OVI Labs Preferences"
>
  <SettingsIcon />
</button>
```

### OHIF Extension Preferences Pattern

OHIF extensions can define preferences via the extension configuration:

```javascript
// frontend/extensions/ovi-labs/src/index.tsx

export default {
  id: 'ovi-labs',
  // ... other extension properties

  // Define default preferences
  getPreferences: () => {
    return {
      segmentationBackendUrl: {
        type: 'string',
        default: 'http://localhost:8000',
        label: 'Segmentation Backend URL',
        description: 'URL of the MedEx segmentation backend API',
      },
    };
  },

  // Apply preferences when they change
  onPreferencesChange: (preferences) => {
    if (preferences.segmentationBackendUrl) {
      setSegmentationBackendUrl(preferences.segmentationBackendUrl);
    }
  },
};
```

## Testing Different Backends

### Local Development
```bash
REACT_APP_SEGMENTATION_API_URL=http://localhost:8000 yarn dev
```

### Remote Testing
```bash
REACT_APP_SEGMENTATION_API_URL=https://dev-api.medex.example.com yarn dev
```

### Production Build
```bash
# In frontend/.env.production
REACT_APP_SEGMENTATION_API_URL=https://api.medex.example.com
yarn build
```

## Troubleshooting

### Backend Not Available

If the frontend shows "Backend unavailable" warning:

1. **Check backend is running**:
   ```bash
   curl http://localhost:8000/health
   # Should return: {"status":"ok"}
   ```

2. **Check CORS configuration**:
   Backend must allow frontend origin. In `backend/segmentation/app/main.py`:
   ```python
   app.add_middleware(
       CORSMiddleware,
       allow_origins=["http://localhost:3000"],  # Frontend URL
       allow_credentials=True,
       allow_methods=["*"],
       allow_headers=["*"],
   )
   ```

3. **Check network connectivity**:
   ```bash
   # From your machine
   curl http://localhost:8000/api/v1/models
   ```

4. **Check browser console**:
   - Open DevTools (F12)
   - Look for CORS errors or network failures
   - Check the Network tab for failed requests

### Wrong Backend URL

If backend URL is incorrect:

1. **Via Environment Variable**:
   ```bash
   # Update frontend/.env.local
   REACT_APP_SEGMENTATION_API_URL=http://correct-url:8000

   # Restart dev server
   yarn dev
   ```

2. **Via Browser Console** (temporary, for debugging):
   ```javascript
   // In browser console
   window.setSegmentationBackendUrl = (await import('./services/segmentationApi')).setSegmentationBackendUrl;
   window.setSegmentationBackendUrl('http://new-url:8000');
   ```

## API Endpoints Reference

All endpoints are relative to the configured backend URL.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/api/v1/models` | GET | List available models |
| `/api/v1/segment` | POST | Submit segmentation job |
| `/api/v1/jobs/{job_id}` | GET | Get job status/result |

## Security Considerations

### Development
- `http://localhost:8000` is fine for local development
- No authentication required (for now)

### Production
- **Use HTTPS**: `https://api.medex.example.com`
- **Enable authentication**: JWT tokens from auth-service
- **Restrict CORS**: Only allow production frontend origin
- **Rate limiting**: Prevent abuse
- **Input validation**: Backend validates all requests

## Future Enhancements

1. **Multi-Backend Support**: Allow users to configure multiple backend URLs and switch between them
2. **Backend Discovery**: Auto-discover backends on local network
3. **Health Monitoring**: Show backend status (latency, uptime) in UI
4. **Backend Profiles**: Save named profiles (e.g., "Local Dev", "Staging", "Production")
