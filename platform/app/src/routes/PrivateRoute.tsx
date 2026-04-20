import { useUserAuthentication } from '@ohif/ui-next';
import authService from '../services/authService';

export const PrivateRoute = ({ children, handleUnauthenticated }) => {
  const authState = useUserAuthentication();
  const { user, enabled, token, isAuthenticated } = authState[0] || authState;
  const hasActiveSession =
    Boolean(user) ||
    Boolean(token) ||
    Boolean(isAuthenticated) ||
    authService.isAuthenticated();

  console.log('PrivateRoute - enabled:', enabled, 'user:', user, 'hasActiveSession:', hasActiveSession);

  if (enabled && !hasActiveSession) {
    console.log('PrivateRoute - User not authenticated, calling handleUnauthenticated');
    return handleUnauthenticated();
  }

  console.log('PrivateRoute - User authenticated, rendering children');
  return children;
};

export default PrivateRoute;
