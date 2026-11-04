// src/pages/VerifyEmailPage.jsx — /auth/verify?token=... (link from the confirmation email)
import React, { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { useAuth } from "@/context/AuthContext";

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const { verifyEmail, user } = useAuth();
  const [state, setState] = useState(token ? "working" : "missing");
  const [message, setMessage] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    verifyEmail(token)
      .then(() => setState("done"))
      .catch((e) => {
        setState("error");
        setMessage(e?.message || "This link is invalid or has expired.");
      });
  }, [token, verifyEmail]);

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-3 sm:px-4 py-12 md:py-20 bg-[#FADADD]">
      <Card className="w-full max-w-md shadow-md border-plum/10 bg-white">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold text-plum">Confirm your email</CardTitle>
        </CardHeader>
        <CardContent className="text-center text-plum/80 text-sm" role="status">
          {state === "working" && "Confirming your email…"}
          {state === "done" && "Thank you! Your email is confirmed and your bookings are linked to your account."}
          {state === "error" && message}
          {state === "missing" && "This confirmation link is missing its code. Please use the link from your email."}
        </CardContent>
        <CardFooter className="justify-center">
          <Link to={user ? "/portal" : "/auth"} className="text-sm font-semibold text-gold hover:underline">
            {user ? "Go to my account" : "Sign in"}
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
