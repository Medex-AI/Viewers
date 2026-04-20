import authService from './authService';
import { setAuthServiceReference } from '../../../core/src/services/UserAuthenticationService/UserAuthenticationService';

// Store reference to the services manager for later use
let servicesManager: any = null;

// Initialize the integration between our authService and OHIF's UserAuthenticationService
export const initializeAuthServiceIntegration = (services?: any) => {
  // Set the auth service reference for the UserAuthenticationService first so
  // protected-route checks can see persisted JWT state during initial render.
  setAuthServiceReference(authService);

  // Store services manager reference
  if (services) {
    servicesManager = services;
    
    // Check if user is already logged in and sync with OHIF
    const currentUser = authService.getCurrentUser();
    const isAuthenticated = authService.isAuthenticated();
    
    console.log('Initializing auth integration - User:', currentUser, 'Authenticated:', isAuthenticated);
    
    if (isAuthenticated && currentUser && services.services?.userAuthenticationService) {
      console.log('Setting existing user in UserAuthenticationService');
      services.services.userAuthenticationService.setUser(currentUser);
    }
  }
  
  console.log('Auth service integration initialized');
};

// Helper function to notify OHIF when user logs in
export const notifyUserLogin = (user: any) => {
  if (servicesManager?.services?.userAuthenticationService) {
    servicesManager.services.userAuthenticationService.setUser(user);
  }
};

export default initializeAuthServiceIntegration;
