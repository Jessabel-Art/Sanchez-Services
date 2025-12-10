// src/App.jsx
import React from 'react';
import { Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Toaster } from '@/components/ui/toaster';

// Layout
import Header from '@/components/common/Header';
import Footer from '@/components/sections/Footer';
import ScrollToTop from '@/components/common/ScrollToTop';

// Pages
import HomePage from '@/pages/HomePage';
import ServicesPage from '@/pages/ServicesPage';
import BookingPage from '@/pages/BookingPage';
import ConfirmationPage from '@/pages/ConfirmationPage';
import ContactPage from '@/pages/ContactPage';
import PrivacyPolicyPage from '@/pages/PrivacyPolicyPage';
import TermsOfServicePage from '@/pages/TermsOfServicePage';
import BrandStylePage from '@/pages/BrandStylePage';
import AdminDashboard from '@/pages/admin/AdminDashboard';
import AuthPage from '@/pages/AuthPage';
import ClientPortalPage from '@/pages/ClientPortalPage.jsx';
import PaymentCenterPage from "@/pages/PaymentCenterPage";
import PaymentConfirmationPage from "@/pages/PaymentConfirmationPage";


// Auth wrappers
import AdminRoute from '@/components/auth/AdminRoute';
import ClientRoute from '@/components/auth/ClientRoute';

function AppShell() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-light-pink flex flex-col">
      <Helmet>
        <title>
          Sanchez Services — Professional Cleaning Services | Where Clean Meets Care
        </title>
        <meta
          name="description"
          content="Professional residential and commercial cleaning services. Licensed & insured. Get your free quote today - your home, our priority, every time."
        />
      </Helmet>

      <ScrollToTop />
      <Header />

      <main id="main-content" className="flex-grow">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<HomePage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/book" element={<BookingPage />} />
          <Route path="/confirm" element={<ConfirmationPage />} />
          <Route path="/auth" element={<AuthPage />} />

          {/* Client portal now uses ClientPortalPage */}
          <Route
            path="/portal"
            element={
              <ClientRoute>
                <ClientPortalPage />
              </ClientRoute>
            }
          />

          {/* Payment center (new) */}
          <Route path="/payment-center" element={<PaymentCenterPage />} />

          <Route
            path="/admin"
            element={
              <AdminRoute>
                <AdminDashboard />
              </AdminRoute>
            }
          />

          <Route
            path="/admin/bookings"
            element={<Navigate to="/admin" state={{ initialView: "bookings" }} replace />}
          />

          <Route
            path="/admin/payments"
            element={<Navigate to="/admin" state={{ initialView: "payments" }} replace />}
          />

          <Route path="/payment-confirmation" element={<PaymentConfirmationPage />} />

          <Route
            path="/admin/client-bookings"
            element={<Navigate to="/admin" state={{ initialView: "bookings" }} replace />}
          />

          <Route path="/contact" element={<ContactPage />} />
          <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
          <Route path="/terms-of-service" element={<TermsOfServicePage />} />
          <Route path="/brand-style" element={<BrandStylePage />} />

          {/* Old alias – keep redirecting to portal */}
          <Route path="/account" element={<Navigate to="/portal" replace />} />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <Footer />
      <Toaster />
    </div>
  );
}

export default function App() {
  return <AppShell />;
}
