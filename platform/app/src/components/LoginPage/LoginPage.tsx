import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoginPageProps } from './types';
import styles from './LoginPage.module.css';
import authService from '../../services/authService';
import { notifyUserLogin } from '../../services/authServiceIntegration';

const LOGO_URL = '/assets/images/medex-logo.svg';

const LoginPage: React.FC<LoginPageProps> = ({ onLogin, redirectTo }) => {
  console.log('LoginPage component loaded'); // Debug log
  
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    console.log('Form submitted!'); // Debug log
    e.preventDefault();
    setIsLoading(true);
    setError('');

    console.log('Attempting login with:', username); // Debug log

    try {
      const result = await authService.login(username, password);
      console.log('Login result:', result); // Debug log
      
      if (result.success && result.user) {
        console.log('Login successful, user:', result.user);
        
        // Notify OHIF's UserAuthenticationService about the login
        notifyUserLogin(result.user);
        
        // Update the user authentication service
        if (onLogin) {
          onLogin(result.user);
        }
        
        // Use React Router navigation instead of window.location.href
        // This avoids a full page reload and maintains authentication state
        const redirectUrl = redirectTo || new URLSearchParams(window.location.search).get('redirect') || '/app';
        console.log('Navigating to:', redirectUrl);
        
        // Small delay to ensure authentication state is fully synchronized
        setTimeout(() => {
          navigate(redirectUrl, { replace: true });
        }, 100);
      } else {
        console.log('Login failed:', result.error); // Debug log
        setError(result.error || 'Login failed');
      }
    } catch (err) {
      console.error('Login error:', err); // Debug log
      setError('An unexpected error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.loginBox}>
        <img src={LOGO_URL} alt="Ovi Lab Logo" className={styles.logo} />
        <h1 className={styles.title}>Welcome to Ovi Lab</h1>
        <p className={styles.subtitle}>Sign in to access your account</p>
        <form onSubmit={handleSubmit} className={styles.form}>
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            className={styles.input}
            aria-label="Username"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className={styles.input}
            aria-label="Password"
            required
          />
          <button type="submit" className={styles.button} disabled={isLoading}>
            {isLoading ? 'Signing In...' : 'Sign In'}
          </button>
        </form>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </div>
  );
};

export default LoginPage;