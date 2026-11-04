// src/pages/ResetPasswordPage.jsx
// Password reset landing page (/auth/reset?token=...), linked from the reset email.
import React, { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/use-toast';
import { useAuth } from '@/context/AuthContext';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { confirmReset } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) {
      setError('Password should be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await confirmReset(token, password);
      toast({ title: 'Password updated', description: 'You can now use your new password.' });
      navigate('/portal', { replace: true });
    } catch (err) {
      setError(err?.message || 'This password reset link is invalid or has expired.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-[70vh] flex items-center justify-center px-3 sm:px-4 py-12 md:py-20 bg-[#FADADD]">
      <div className="w-full max-w-md">
        <Card className="shadow-md border-plum/10 bg-white">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold text-plum">Choose a new password</CardTitle>
            <CardDescription>Enter a new password for your Sanchez Services account.</CardDescription>
          </CardHeader>
          {!token ? (
            <CardContent>
              <p className="text-sm text-plum/80" role="alert">
                This reset link is missing its code. Please use the link from your email, or request a new one.
              </p>
            </CardContent>
          ) : (
            <form onSubmit={onSubmit}>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="new-password">New password</Label>
                  <Input id="new-password" type="password" autoComplete="new-password" value={password}
                    onChange={(e) => setPassword(e.target.value)} required minLength={6} className="bg-white" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm-password">Confirm new password</Label>
                  <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm}
                    onChange={(e) => setConfirm(e.target.value)} required minLength={6} className="bg-white" />
                </div>
                {error && <p className="text-sm text-rose-700" role="alert">{error}</p>}
              </CardContent>
              <CardFooter className="flex flex-col gap-3">
                <Button type="submit" className="w-full bg-gold text-white" disabled={busy}>
                  {busy ? 'Saving…' : 'Save new password'}
                </Button>
              </CardFooter>
            </form>
          )}
          <CardFooter>
            <Link to="/auth" className="text-sm text-plum/80 hover:underline mx-auto">Back to sign in</Link>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
