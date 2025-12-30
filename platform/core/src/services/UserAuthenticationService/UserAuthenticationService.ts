import { PubSubService } from '../_shared/pubSubServiceInterface';

// Import authService - we'll need to handle the import path properly
// This will be resolved when the app initializes and sets the implementation
let authService: any = null;

// Helper function to set the auth service reference
export const setAuthServiceReference = (service: any) => {
  authService = service;
};

class UserAuthenticationService extends PubSubService {
  public static readonly EVENTS = {
    USER_AUTHENTICATED: 'event::userAuthenticated',
    USER_UNAUTHENTICATED: 'event::userUnauthenticated',
  };

  public static REGISTRATION = {
    name: 'userAuthenticationService',
    altName: 'UserAuthenticationService',
    create: ({ configuration = {} }) => {
      return new UserAuthenticationService();
    },
  };

  private currentUser: any = null;
  private authState: any = null;

  serviceImplementation = {
    _getState: () => {
      const user = authService?.getCurrentUser() || this.currentUser;
      const isAuthenticated = authService?.isAuthenticated() || false;

      // Read auth enabled flag from environment variable
      const authEnabled = process.env.REACT_APP_ENABLE_AUTH !== 'false';

      console.log('UserAuthenticationService _getState - user:', user, 'authenticated:', isAuthenticated, 'enabled:', authEnabled);

      return {
        isAuthenticated,
        user,
        token: authService?.getToken() || null,
        enabled: authEnabled,
      };
    },
    _setUser: (user: any) => {
      console.log('UserAuthenticationService _setUser called with:', user);
      this.currentUser = user;
      this.authState = { ...this.authState, user };
      this._broadcastEvent(UserAuthenticationService.EVENTS.USER_AUTHENTICATED, { user });
    },
    _getUser: () => {
      const user = authService?.getCurrentUser() || this.currentUser;
      console.log('UserAuthenticationService _getUser returning:', user);
      return user;
    },
    _getAuthorizationHeader: () => {
      const token = authService?.getToken();
      return token ? `Bearer ${token}` : null;
    },
    _handleUnauthenticated: () => {
      if (authService) {
        authService.clearToken();
      }
      this.currentUser = null;
      this.authState = null;
      this._broadcastEvent(UserAuthenticationService.EVENTS.USER_UNAUTHENTICATED, {});
      
      // Redirect to login page
      const currentPath = window.location.pathname + window.location.search;
      const loginUrl = `/login?redirect=${encodeURIComponent(currentPath)}`;
      window.location.href = loginUrl;
    },
    _reset: () => {
      if (authService) {
        authService.clearToken();
      }
      this.currentUser = null;
      this.authState = null;
      this._broadcastEvent(UserAuthenticationService.EVENTS.USER_UNAUTHENTICATED, {});
    },
    _set: (state: any) => {
      this.authState = { ...this.authState, ...state };
      if (state.user) {
        this.currentUser = state.user;
      }
    },
  };

  constructor() {
    super(UserAuthenticationService.EVENTS);
    this.serviceImplementation = {
      ...this.serviceImplementation,
    };
  }

  public getState() {
    return this.serviceImplementation._getState();
  }

  public setUser(user) {
    return this.serviceImplementation._setUser(user);
  }

  public getUser() {
    return this.serviceImplementation._getUser();
  }

  public getAuthorizationHeader() {
    return this.serviceImplementation._getAuthorizationHeader();
  }

  public handleUnauthenticated() {
    return this.serviceImplementation._handleUnauthenticated();
  }

  public reset() {
    return this.serviceImplementation._reset();
  }

  public set(state) {
    return this.serviceImplementation._set(state);
  }

  public setServiceImplementation({
    getState: getStateImplementation,
    setUser: setUserImplementation,
    getUser: getUserImplementation,
    getAuthorizationHeader: getAuthorizationHeaderImplementation,
    handleUnauthenticated: handleUnauthenticatedImplementation,
    reset: resetImplementation,
    set: setImplementation,
  }) {
    if (getStateImplementation) {
      this.serviceImplementation._getState = getStateImplementation;
    }
    if (setUserImplementation) {
      this.serviceImplementation._setUser = setUserImplementation;
    }
    if (getUserImplementation) {
      this.serviceImplementation._getUser = getUserImplementation;
    }
    if (getAuthorizationHeaderImplementation) {
      this.serviceImplementation._getAuthorizationHeader = getAuthorizationHeaderImplementation;
    }
    if (handleUnauthenticatedImplementation) {
      this.serviceImplementation._handleUnauthenticated = handleUnauthenticatedImplementation;
    }
    if (resetImplementation) {
      this.serviceImplementation._reset = resetImplementation;
    }
    if (setImplementation) {
      this.serviceImplementation._set = setImplementation;
    }
  }
}

export default UserAuthenticationService;
