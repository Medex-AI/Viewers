interface User {
  id: string;
  username: string;
  email?: string;
}

interface AuthResult {
  success: boolean;
  user?: User;
  token?: string;
  error?: string;
}

interface AuthService {
  login(username: string, password: string): Promise<AuthResult>;
  logout(): Promise<void>;
  refreshToken(): Promise<string>;
  getCurrentUser(): User | null;
  isAuthenticated(): boolean;
  getToken(): string | null;
  setToken(token: string): void;
  clearToken(): void;
}

class AuthServiceImpl implements AuthService {
  private baseUrl: string;
  private currentUser: User | null = null;
  private token: string | null = null;

  constructor() {
    // Handle environment variable safely for browser environment
    this.baseUrl = (typeof process !== 'undefined' && process.env?.REACT_APP_AUTH_API_URL) || 'http://localhost:5000/api/auth';
    // Initialize from localStorage on startup
    this.initializeFromStorage();
  }

  private initializeFromStorage(): void {
    const storedToken = localStorage.getItem('auth_token');
    const storedUser = localStorage.getItem('auth_user');
    
    if (storedToken && storedUser) {
      try {
        this.token = storedToken;
        this.currentUser = JSON.parse(storedUser);
      } catch (error) {
        console.error('Failed to parse stored user data:', error);
        this.clearToken();
      }
    }
  }

  async login(username: string, password: string): Promise<AuthResult> {
    try {
      console.log('Making login request to:', `${this.baseUrl}/login`);
      const response = await fetch(`${this.baseUrl}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();
      console.log('Login response status:', response.status);
      console.log('Login response data:', data);

      // Backend returns 'token' not 'access_token'
      const token = data.access_token || data.token;
      
      if (response.ok && token) {
        const user: User = {
          id: data.user?.id || username,
          username: data.user?.username || username,
          email: data.user?.email,
        };

        this.setToken(token);
        this.currentUser = user;
        
        // Store in localStorage for persistence
        localStorage.setItem('auth_user', JSON.stringify(user));

        return {
          success: true,
          user,
          token: token,
        };
      } else {
        return {
          success: false,
          error: data.message || 'Login failed',
        };
      }
    } catch (error) {
      console.error('Login error:', error);
      return {
        success: false,
        error: 'Network error occurred during login',
      };
    }
  }

  async logout(): Promise<void> {
    try {
      // Attempt to notify the server about logout
      if (this.token) {
        await fetch(`${this.baseUrl}/logout`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          credentials: 'include',
        });
      }
    } catch (error) {
      console.error('Logout API call failed:', error);
      // Continue with local cleanup even if server call fails
    } finally {
      this.clearToken();
    }
  }

  async refreshToken(): Promise<string> {
    if (!this.token) {
      throw new Error('No token available for refresh');
    }

    try {
      const response = await fetch(`${this.baseUrl}/refresh`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });

      const data = await response.json();

      if (response.ok && data.access_token) {
        this.setToken(data.access_token);
        return data.access_token;
      } else {
        throw new Error(data.message || 'Token refresh failed');
      }
    } catch (error) {
      console.error('Token refresh error:', error);
      this.clearToken();
      throw error;
    }
  }

  getCurrentUser(): User | null {
    return this.currentUser;
  }

  isAuthenticated(): boolean {
    return this.token !== null && this.currentUser !== null;
  }

  getToken(): string | null {
    return this.token;
  }

  setToken(token: string): void {
    this.token = token;
    localStorage.setItem('auth_token', token);
  }

  clearToken(): void {
    this.token = null;
    this.currentUser = null;
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
  }

  // Utility method to check if token is expired (basic JWT parsing)
  private isTokenExpired(token: string): boolean {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const currentTime = Date.now() / 1000;
      return payload.exp < currentTime;
    } catch (error) {
      console.error('Error parsing token:', error);
      return true;
    }
  }

  // Method to automatically handle token refresh
  async ensureValidToken(): Promise<string | null> {
    if (!this.token) {
      return null;
    }

    if (this.isTokenExpired(this.token)) {
      try {
        return await this.refreshToken();
      } catch (error) {
        console.error('Failed to refresh expired token:', error);
        return null;
      }
    }

    return this.token;
  }
}

// Export singleton instance
export const authService = new AuthServiceImpl();
export default authService;

// Export types for use in other components
export type { User, AuthResult, AuthService };