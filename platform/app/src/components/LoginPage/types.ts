// Import User type from authService to maintain consistency
export interface User {
  id: string;
  username: string;
  email?: string;
}

export interface LoginPageProps {
  onLogin?: (user: User) => void;
  redirectTo?: string;
}