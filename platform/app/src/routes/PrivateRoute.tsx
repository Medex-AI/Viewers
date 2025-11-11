import { useUserAuthentication } from '@ohif/ui-next';

export const PrivateRoute = ({ children, handleUnauthenticated }) => {
  const authState = useUserAuthentication();
  const { user, enabled } = authState[0] || authState;

  console.log('PrivateRoute - enabled:', enabled, 'user:', user);

  if (enabled && !user) {
    console.log('PrivateRoute - User not authenticated, calling handleUnauthenticated');
    return handleUnauthenticated();
  }

  console.log('PrivateRoute - User authenticated, rendering children');
  return children;
};

export default PrivateRoute;
