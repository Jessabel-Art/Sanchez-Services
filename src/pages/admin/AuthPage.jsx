// pages/admin/AuthPage.jsx
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../../lib/firebase";
import { upsertProfile, updateProfileLastLogin } from "@/lib/profileModel";

const AuthPage = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      // ✅ Perform sign in
      const cred = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );

      // ✅ Record last login in profiles (does NOT affect redirect)
      try {
        await updateProfileLastLogin(cred.user);
      } catch (profileErr) {
        // Don’t block login if this fails, just log it
        console.error("Failed to update lastLoginAt in profiles:", profileErr);
      }

      // onAuthStateChanged in useAdminAuth will handle redirecting state in AdminDashboard
    } catch (err) {
      console.error(err);
      setError("Login failed. Check your email and password.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FCEFF6] px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8">
        <div className="mb-6 text-center">
          <div className="font-semibold text-sm text-[#B34A87] tracking-wide uppercase mb-2">
            Sanchez Services
          </div>
          <h1 className="text-2xl font-bold text-[#431039]">
            Admin sign in
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Access your bookings, calendar, and reports.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[#431039] mb-1">
              Email
            </label>
            <input
              type="email"
              autoComplete="email"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#B34A87]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[#431039] mb-1">
              Password
            </label>
            <input
              type="password"
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#B34A87]"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex justify-center items-center rounded-lg bg-[#E2A82B] text-[#431039] font-semibold text-sm py-2.5 hover:bg-[#F0BA3E] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <Link
          to="/"
          className="mt-4 block text-center text-xs text-gray-500 hover:text-gray-700"
        >
          ← Back to website
        </Link>
      </div>
    </div>
  );
};

export default AuthPage;
