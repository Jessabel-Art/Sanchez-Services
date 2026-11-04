// src/pages/BookingPage.jsx
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Calendar } from '@/components/ui/calendar';
import { useToast } from '@/components/ui/use-toast';
import { Home, Sparkles, Truck, Building, Clock, ChevronRight, Tag, Info, AlertCircle, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ADD_ONS, FREQUENCIES, SERVICES } from '@/data/services';
import { useAuth } from '@/context/AuthContext';
import { apiGet, apiPost, qs } from '@/lib/api';
import { normalizeBooking, dateKey as toDateKey } from '@/lib/model';

// ----- Constants -----
const SERVICE_ICONS = { Home, Sparkles, Truck, Building };
const services = SERVICES.map((service) => ({
  id: service.slug,
  name: service.bookingName,
  icon: SERVICE_ICONS[service.icon] || Home,
}));

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
];

const addons = ADD_ONS.map((addon) => ({ ...addon, name: addon.label }));
const frequencies = FREQUENCIES;

// ===== Solid, readable Select styles =====
const selectTriggerClass =
  'bg-white text-plum border border-plum/30 rounded-md ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 focus:border-gold/60';
const selectContentClass = 'bg-white border border-plum/20 text-plum shadow-xl';
const selectItemClass = 'focus:bg-gold/10 focus:text-plum cursor-pointer';

const STORAGE_KEY = 'booking_form_v2';

/** Server error -> form field key */
const FIELD_MAP = {
  'contact.name': 'firstName', 'contact.phone': 'phone', 'contact.email': 'email', 'address.line1': 'street',
  'address.city': 'city', 'address.state': 'state', 'address.zip': 'zip', sqft: 'sqft', promoCode: 'promoCode',
};

function newRequestId() {
  const r = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `req_${r.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

const BookingPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, authReady } = useAuth();

  const bookingId = searchParams.get('bookingId');
  const [isEditing, setIsEditing] = useState(Boolean(bookingId));
  const [loadedBooking, setLoadedBooking] = useState(null);

  // Saved addresses for dropdown
  const [addressOptions, setAddressOptions] = useState([]);
  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [loadingAddresses, setLoadingAddresses] = useState(false);
  const [saveAddress, setSaveAddress] = useState(true);

  // Business rules from the server
  const [rules, setRules] = useState(null);

  const [form, setForm] = useState(() => {
    let base = {};
    try {
      base = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      base = {};
    }
    return {
      service: base.service || searchParams.get('service') || 'residential-cleaning',
      propertyType: base.propertyType || 'house',
      sqft: base.sqft ?? 1500,
      bedrooms: base.bedrooms ?? 2,
      bathrooms: base.bathrooms ?? 1,
      sizeMode: base.sizeMode || 'bed-bath',
      condition: base.condition || 'standard',
      pets: base.pets || 'no',
      addons: base.addons || [],
      frequency: base.frequency || 'one-time',
      date: base.date ? new Date(base.date) : null,
      time: '',
      firstName: base.firstName || '',
      lastName: base.lastName || '',
      email: '',
      phone: base.phone || '',
      street: base.street || '',
      city: base.city || '',
      state: base.state || '',
      zip: base.zip || '',
      accessNotes: base.accessNotes || '',
      cleanerNotes: base.cleanerNotes || '',
      promoCode: base.promoCode || '',
      agreePolicy: false,
    };
  });

  // Server quote (single source of pricing)
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [promoApplied, setPromoApplied] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const requestIdRef = useRef(newRequestId());

  // Day availability from the server
  const [day, setDay] = useState(null);
  const [availabilityStatus, setAvailabilityStatus] = useState('idle');
  const [availabilityError, setAvailabilityError] = useState('');
  const [loadingDay, setLoadingDay] = useState(false);
  const [unavailableDates, setUnavailableDates] = useState(new Set());

  const [errors, setErrors] = useState({});
  const estimateLiveRef = useRef(null);

  // Estimate view-model (keeps the existing sidebar markup)
  const estimate = useMemo(() => {
    const total = quote?.totalPrice ?? 0;
    return { total, duration: quote?.durationHours ?? 0, lineItems: quote?.lineItems ?? [] };
  }, [quote]);

  useEffect(() => {
    apiGet('/catalog').then((c) => setRules(c.rules)).catch(() => setRules(null));
  }, []);

  // Require sign-in to book (the booking belongs to the account)
  useEffect(() => {
    if (authReady && !user) {
      navigate(`/auth?redirect=${encodeURIComponent('/book' + (bookingId ? `?bookingId=${bookingId}` : ''))}`, { replace: true });
    }
  }, [authReady, user, navigate, bookingId]);

  // Load booking for reschedule
  useEffect(() => {
    if (!bookingId || !user) return;
    let cancelled = false;
    apiGet(`/bookings/${encodeURIComponent(bookingId)}`)
      .then(({ booking }) => {
        if (cancelled) return;
        const b = normalizeBooking(booking);
        if (!b.permissions?.canReschedule) {
          toast({ variant: 'destructive', title: 'This booking cannot be rescheduled online', description: b.permissions?.changeBlockedReason || 'Please contact us to make changes.' });
          setIsEditing(false);
          navigate('/portal', { replace: true });
          return;
        }
        setLoadedBooking(b);
        const [first, ...rest] = String(b.contact?.name || '').split(/\s+/);
        setForm((prev) => ({
          ...prev,
          service: b.serviceSlug || prev.service,
          propertyType: b.propertyType || prev.propertyType,
          sqft: b.sqft ?? prev.sqft,
          bedrooms: b.bedrooms ?? prev.bedrooms,
          bathrooms: b.bathrooms ?? prev.bathrooms,
          condition: b.condition || 'standard',
          pets: b.pets ? 'yes' : 'no',
          addons: b.addons || [],
          frequency: b.frequency || 'one-time',
          date: null,
          time: '',
          firstName: first || '',
          lastName: rest.join(' '),
          email: b.contact?.email || '',
          phone: b.contact?.phone || '',
          street: b.address?.line1 || '',
          city: b.address?.city || '',
          state: b.address?.state || '',
          zip: b.address?.zip || '',
          accessNotes: b.accessNotes || '',
          cleanerNotes: b.cleanerNotes || '',
          promoCode: b.promoCode || '',
          agreePolicy: true,
        }));
        setPromoApplied(!!b.promoCode);
      })
      .catch(() => {
        if (!cancelled) {
          toast({ variant: 'destructive', title: 'Booking not found' });
          setIsEditing(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, user]);

  // Prefill contact + saved addresses (new bookings)
  useEffect(() => {
    if (!user || isEditing) return;
    let cancelled = false;
    setLoadingAddresses(true);
    Promise.all([apiGet('/me/profile'), apiGet('/me/addresses')])
      .then(([{ profile }, { addresses }]) => {
        if (cancelled) return;
        const [first, ...rest] = String(profile.name || '').trim().split(/\s+/).filter(Boolean);
        const def = addresses.find((a) => a.isDefault) || addresses[0];
        setAddressOptions(addresses);
        setForm((prev) => ({
          ...prev,
          email: profile.email || user.email,
          firstName: prev.firstName || first || '',
          lastName: prev.lastName || rest.join(' '),
          phone: prev.phone || profile.phone || '',
          ...(def && !prev.street
            ? { street: def.line1, city: def.city, state: def.state, zip: def.zip, accessNotes: prev.accessNotes || def.accessInstructions || '' }
            : {}),
        }));
        if (def) setSelectedAddressId(String(def.id));
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoadingAddresses(false));
    return () => {
      cancelled = true;
    };
  }, [user, isEditing]);

  const handleFormChange = (field, value) => {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      try {
        const { email, agreePolicy, time, ...persist } = next;
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...persist, date: next.date ? next.date.toISOString() : null }));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };

  const handleAddonToggle = (addonId) => {
    const newAddons = form.addons.includes(addonId) ? form.addons.filter((id) => id !== addonId) : [...form.addons, addonId];
    handleFormChange('addons', newAddons);
  };

  const quoteInput = useMemo(() => {
    const isOffice = form.service === 'office-cleaning';
    return {
      serviceSlug: form.service,
      bedrooms: isOffice ? 0 : Number(form.bedrooms) || 0,
      bathrooms: isOffice ? 0 : Number(form.bathrooms) || 0,
      sqft: isOffice || form.sizeMode === 'sqft' ? Number(form.sqft) || 0 : 0,
      condition: form.condition,
      pets: form.pets === 'yes',
      addons: form.addons,
      frequency: form.frequency,
      promoCode: promoApplied ? form.promoCode.trim() : '',
    };
  }, [form.service, form.bedrooms, form.bathrooms, form.sqft, form.sizeMode, form.condition, form.pets, form.addons, form.frequency, form.promoCode, promoApplied]);

  // Live estimate from the server (debounced)
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      apiPost('/quote', quoteInput)
        .then((q) => {
          if (!cancelled) {
            setQuote(q);
            setQuoteError('');
          }
        })
        .catch((e) => {
          if (cancelled) return;
          setQuoteError(e.message);
          if (e.field === 'promoCode') setPromoApplied(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [quoteInput]);

  const handleApplyPromoCode = async () => {
    const code = (form.promoCode || '').trim();
    if (!code) {
      toast({ title: 'Enter a code to apply' });
      return;
    }
    try {
      await apiPost('/quote', { ...quoteInput, promoCode: code });
      setPromoApplied(true);
      toast({ title: 'Promo code applied!' });
    } catch (e) {
      setPromoApplied(false);
      toast({ title: 'Invalid promo code', description: e.message, variant: 'destructive' });
    }
  };

  const durationMinutes = isEditing && loadedBooking ? loadedBooking.durationMinutes : quote?.durationMinutes || 0;

  // Month view: grey out unavailable dates
  const [visibleMonth, setVisibleMonth] = useState(() => new Date());
  useEffect(() => {
    if (!durationMinutes) return;
    const month = format(visibleMonth, 'yyyy-MM');
    apiGet(`/availability/month${qs({ month, durationMinutes })}`)
      .then(({ days }) => setUnavailableDates(new Set(days.filter((d) => !d.available).map((d) => d.date))))
      .catch(() => setUnavailableDates(new Set()));
  }, [visibleMonth, durationMinutes]);

  // Day availability
  useEffect(() => {
    setForm((prev) => ({ ...prev, time: '' }));
    if (!form.date || !durationMinutes) {
      setDay(null);
      setAvailabilityStatus('idle');
      return;
    }
    let cancelled = false;
    setLoadingDay(true);
    setAvailabilityStatus('loading');
    setAvailabilityError('');
    apiGet(`/availability${qs({ date: format(form.date, 'yyyy-MM-dd'), durationMinutes, booking: isEditing ? bookingId : '' })}`)
      .then((d) => {
        if (cancelled) return;
        setDay(d);
        setAvailabilityStatus('loaded');
      })
      .catch(() => {
        if (cancelled) return;
        setDay(null);
        setAvailabilityStatus('failed');
        setAvailabilityError("We couldn't check availability right now. Please try again.");
      })
      .finally(() => !cancelled && setLoadingDay(false));
    return () => {
      cancelled = true;
    };
  }, [form.date, durationMinutes, isEditing, bookingId]);

  const timeOptionsForUi = useMemo(() => (day?.slots || []).filter((s) => s.available).map((s) => s.label), [day]);
  const slotByLabel = useMemo(() => Object.fromEntries((day?.slots || []).map((s) => [s.label, s])), [day]);

  const validateForm = () => {
    const next = {};
    ['firstName', 'lastName', 'phone', 'street', 'city', 'state', 'zip', 'date', 'time'].forEach((k) => {
      if (!form[k] || (typeof form[k] === 'string' && !form[k].trim())) next[k] = 'Required';
    });
    if (!form.agreePolicy) next.agreePolicy = 'You must agree to the estimate and deposit policy.';
    if (form.phone && String(form.phone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').length !== 10) next.phone = 'Enter a valid 10-digit phone number.';
    if (form.zip && !/^\d{5}(-\d{4})?$/.test(form.zip)) next.zip = 'Enter a valid ZIP.';
    if (form.time && !timeOptionsForUi.includes(form.time)) next.time = 'This time is no longer available.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  // Submit
  const handleProceedToCheckout = async () => {
    if (isSubmitting) return;
    if (!user) {
      navigate(`/auth?redirect=${encodeURIComponent('/book')}`);
      return;
    }
    if (!validateForm()) {
      toast({ variant: 'destructive', title: 'Please fix the highlighted fields', description: 'We need a few details to lock in your booking.' });
      return;
    }
    const slot = slotByLabel[form.time];
    setIsSubmitting(true);
    try {
      if (isEditing && bookingId) {
        await apiPost(`/bookings/${encodeURIComponent(bookingId)}/reschedule`, { date: format(form.date, 'yyyy-MM-dd'), time: slot.time });
        toast({ title: 'Appointment rescheduled', description: 'We emailed you the new details.' });
        navigate(`/confirm?booking=${encodeURIComponent(bookingId)}&rescheduled=1`);
        return;
      }
      const res = await apiPost('/bookings', {
        requestId: requestIdRef.current,
        ...quoteInput,
        propertyType: form.propertyType,
        date: format(form.date, 'yyyy-MM-dd'),
        time: slot.time,
        contact: { name: `${form.firstName.trim()} ${form.lastName.trim()}`.trim(), email: form.email || user.email, phone: form.phone },
        address: { line1: form.street, city: form.city, state: form.state, zip: form.zip },
        accessNotes: form.accessNotes,
        cleanerNotes: form.cleanerNotes,
        saveAddress: saveAddress && !selectedAddressId,
      });
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      navigate(`/confirm?booking=${encodeURIComponent(res.booking.id)}`);
    } catch (err) {
      requestIdRef.current = newRequestId(); // a failed attempt can be retried with a fresh request
      if (err.field && FIELD_MAP[err.field]) setErrors((prev) => ({ ...prev, [FIELD_MAP[err.field]]: err.message }));
      if (err.code === 'already-exists' || err.code === 'resource-exhausted') {
        setDay(null);
        setForm((prev) => ({ ...prev, date: new Date(prev.date) })); // re-fetch availability
      }
      toast({ variant: 'destructive', title: err.code === 'already-exists' ? 'That time was just taken' : 'Could not save booking', description: err.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  // a11y live region
  useEffect(() => {
    if (estimateLiveRef.current) {
      estimateLiveRef.current.textContent = `Estimated total ${estimate.total.toFixed(
        2
      )} dollars, duration approximately ${estimate.duration} hours.`;
    }
  }, [estimate.total, estimate.duration]);

  return (
    <TooltipProvider>
      <div className="py-12 sm:py-16 md:py-20 px-3 sm:px-4 bg-[#FADADD]">
        <div className="max-w-6xl mx-auto">
          <motion.div className="text-center mb-8 sm:mb-10 md:mb-12">
            <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-plum mb-3 sm:mb-4">
              {isEditing ? 'Reschedule Your Cleaning' : 'Book Your Cleaning Service'}
            </h1>
            <p className="text-sm sm:text-base md:text-lg text-plum/80">
              {isEditing
                ? 'Pick a new date and time. Details can be adjusted if needed.'
                : 'Get an instant estimate and schedule your appointment in minutes.'}
            </p>
          </motion.div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-7 md:gap-8 items-start">
            <div className="lg:col-span-2 space-y-6 sm:space-y-7 md:space-y-8">
              {/* Step 1 */}
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle className="text-lg sm:text-xl">Step 1: Select Your Service</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
                    {services.map((service) => {
                      const selected = form.service === service.id;
                      return (
                        <button
                          key={service.id}
                          type="button"
                          onClick={() => handleFormChange('service', service.id)}
                          className={[
                            'p-4 border-2 rounded-lg flex flex-col items-center justify-center gap-2 transition-all',
                            'bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50',
                            selected
                              ? 'border-gold bg-gold/10'
                              : 'border-plum/20 hover:border-gold/50',
                          ].join(' ')}
                          aria-pressed={selected}
                          aria-label={service.name}
                        >
                          <service.icon className="w-8 h-8 text-plum" />
                          <span className="text-sm font-medium text-center text-plum">
                            {service.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Step 2 (Contact & Access) */}
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle className="text-lg sm:text-xl">Step 2: Contact & Access Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 sm:space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
                    <div className={errors.firstName ? 'relative' : ''}>
                      <Label htmlFor="firstName">First Name</Label>
                      <Input
                        id="firstName"
                        value={form.firstName}
                        onChange={(e) => handleFormChange('firstName', e.target.value)}
                        aria-invalid={!!errors.firstName}
                        required
                        autoComplete="given-name"
                        className="bg-white"
                      />
                      {errors.firstName && (
                        <p className="text-xs text-red-600 mt-1">{errors.firstName}</p>
                      )}
                    </div>
                    <div className={errors.lastName ? 'relative' : ''}>
                      <Label htmlFor="lastName">Last Name</Label>
                      <Input
                        id="lastName"
                        value={form.lastName}
                        onChange={(e) => handleFormChange('lastName', e.target.value)}
                        aria-invalid={!!errors.lastName}
                        required
                        autoComplete="family-name"
                        className="bg-white"
                      />
                      {errors.lastName && (
                        <p className="text-xs text-red-600 mt-1">{errors.lastName}</p>
                      )}
                    </div>
                    <div className={errors.email ? 'relative' : ''}>
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        value={form.email}
                        readOnly
                        aria-describedby="email-help"
                        autoComplete="email"
                        className="bg-plum/5"
                      />
                      <p id="email-help" className="text-xs text-plum/60 mt-1">
                        Confirmations go to your account email. Change it in your account settings.
                      </p>
                      {errors.email && (
                        <p className="text-xs text-red-600 mt-1">{errors.email}</p>
                      )}
                    </div>
                  </div>

                  {/* Saved address dropdown */}
                  {addressOptions.length > 0 && (
                    <div className="space-y-1">
                      <Label htmlFor="saved-address">Service address</Label>
                      <Select
                        value={selectedAddressId || ''}
                        onValueChange={(v) => {
                          setSelectedAddressId(v);
                          const addr = addressOptions.find((a) => String(a.id) === v);
                          if (addr) {
                            handleFormChange('street', addr.line1 || '');
                            handleFormChange('accessNotes', form.accessNotes || addr.accessInstructions || '');
                            handleFormChange('city', addr.city || '');
                            handleFormChange('state', addr.state || '');
                            handleFormChange('zip', addr.zip || '');
                          }
                        }}
                      >
                        <SelectTrigger
                          id="saved-address"
                          className={selectTriggerClass}
                          disabled={loadingAddresses}
                        >
                          <SelectValue placeholder="Choose a saved address" />
                        </SelectTrigger>
                        <SelectContent className={selectContentClass}>
                          {addressOptions.map((a) => {
                            const nickname = a.label || 'Home';
                            const short = [a.line1, a.city].filter(Boolean).join(', ');
                            return (
                              <SelectItem
                                key={a.id}
                                value={String(a.id)}
                                className={selectItemClass}
                              >
                                {nickname} — {short}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-plum/70">
                        We&apos;ll pre-fill the address fields below. You can still tweak them
                        for this visit.
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className={errors.street ? 'relative' : ''}>
                      <Label htmlFor="street">Street Address</Label>
                      <Input
                        id="street"
                        value={form.street}
                        onChange={(e) => handleFormChange('street', e.target.value)}
                        aria-invalid={!!errors.street}
                        required
                        autoComplete="street-address"
                        className="bg-white"
                      />
                      {errors.street && (
                        <p className="text-xs text-red-600 mt-1">{errors.street}</p>
                      )}
                    </div>

                    <div className={errors.city ? 'relative' : ''}>
                      <Label htmlFor="city">City</Label>
                      <Input
                        id="city"
                        value={form.city}
                        onChange={(e) => handleFormChange('city', e.target.value)}
                        aria-invalid={!!errors.city}
                        required
                        autoComplete="address-level2"
                        className="bg-white"
                      />
                      {errors.city && (
                        <p className="text-xs text-red-600 mt-1">{errors.city}</p>
                      )}
                    </div>

                    <div className={errors.state ? 'relative' : ''}>
                      <Label htmlFor="state">State</Label>
                      <Select
                        value={form.state || ''}
                        onValueChange={(v) => handleFormChange('state', v)}
                      >
                        <SelectTrigger id="state" className={selectTriggerClass}>
                          <SelectValue placeholder="Select a state" />
                        </SelectTrigger>
                        <SelectContent className={`${selectContentClass} max-h-48 overflow-auto`}>
                          {US_STATES.map((s) => (
                            <SelectItem key={s} value={s} className={selectItemClass}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {errors.state && (
                        <p className="text-xs text-red-600 mt-1">{errors.state}</p>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className={errors.phone ? 'relative' : ''}>
                      <Label htmlFor="phone">Phone</Label>
                      <Input
                        id="phone"
                        type="tel"
                        inputMode="tel"
                        placeholder="e.g., (555) 123-4567"
                        value={form.phone}
                        onChange={(e) => handleFormChange('phone', e.target.value)}
                        aria-invalid={!!errors.phone}
                        required
                        autoComplete="tel"
                        className="bg-white"
                      />
                      {errors.phone && (
                        <p className="text-xs text-red-600 mt-1">{errors.phone}</p>
                      )}
                    </div>
                    <div className={errors.zip ? 'relative' : ''}>
                      <Label htmlFor="zip">ZIP Code</Label>
                      <Input
                        id="zip"
                        inputMode="numeric"
                        pattern="\\d{5}(-\\d{4})?"
                        value={form.zip}
                        onChange={(e) => handleFormChange('zip', e.target.value)}
                        aria-invalid={!!errors.zip}
                        required
                        autoComplete="postal-code"
                        className="bg-white"
                      />
                      {errors.zip && (
                        <p className="text-xs text-red-600 mt-1">{errors.zip}</p>
                      )}
                    </div>
                  </div>
                  <div>
                    <Label>Service Frequency</Label>
                    <Select
                      value={form.frequency}
                      onValueChange={(v) => handleFormChange('frequency', v)}
                    >
                      <SelectTrigger className={selectTriggerClass}>
                        <SelectValue placeholder="Select frequency" />
                      </SelectTrigger>
                      <SelectContent className={selectContentClass}>
                        {frequencies.map((freq) => (
                          <SelectItem
                            key={freq.id}
                            value={freq.id}
                            className={selectItemClass}
                          >
                            {freq.name}{' '}
                            {freq.discount > 0 &&
                              `(${Math.round(freq.discount * 100)}% off)`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Access notes */}
                  {!isEditing && !selectedAddressId && (
                    <label className="flex items-center gap-2 text-sm text-plum/80">
                      <Checkbox checked={saveAddress} onCheckedChange={(v) => setSaveAddress(!!v)} />
                      Save this address to my account
                    </label>
                  )}
                  <div>
                    <Label htmlFor="accessNotes">Access Notes (gate codes, parking, etc.)</Label>
                    <Textarea
                      id="accessNotes"
                      value={form.accessNotes}
                      onChange={(e) =>
                        handleFormChange('accessNotes', e.target.value)
                      }
                      className="bg-white"
                    />
                  </div>

                  {/* Special notes for cleaner */}
                  <div>
                    <Label htmlFor="cleanerNotes">Special notes for your cleaner</Label>
                    <Textarea
                      id="cleanerNotes"
                      value={form.cleanerNotes}
                      onChange={(e) =>
                        handleFormChange('cleanerNotes', e.target.value)
                      }
                      className="bg-white"
                      placeholder="Example: Focus on bathrooms and kitchen, avoid strong scents in bedrooms, etc."
                    />
                    <p className="text-xs text-plum/70 mt-1">
                      These notes apply to this visit. Your cleaner will also see any
                      standing preferences saved in your profile.
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Step 3 (Customize) */}
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle>Step 3: Customize Your Cleaning</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {form.service !== 'office-cleaning' ? (
                    <>
                      <div>
                        <Label>Property Type</Label>
                        <RadioGroup
                          value={form.propertyType}
                          onValueChange={(v) => handleFormChange('propertyType', v)}
                          className="flex gap-4 mt-2"
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="house" id="house" />
                            <Label htmlFor="house">House</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="apartment" id="apartment" />
                            <Label htmlFor="apartment">Apartment</Label>
                          </div>
                        </RadioGroup>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className={errors.bedrooms ? 'relative' : ''}>
                          <Label htmlFor="bedrooms">Bedrooms</Label>
                          <Select
                            value={String(form.bedrooms)}
                            onValueChange={(v) =>
                              handleFormChange('bedrooms', Number(v))
                            }
                          >
                            <SelectTrigger
                              className={selectTriggerClass}
                              aria-invalid={!!errors.bedrooms}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className={selectContentClass}>
                              {[...Array(9).keys()].map((i) => (
                                <SelectItem
                                  key={i}
                                  value={String(i)}
                                  className={selectItemClass}
                                >
                                  {i}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className={errors.bathrooms ? 'relative' : ''}>
                          <Label htmlFor="bathrooms">Bathrooms</Label>
                          <Select
                            value={String(form.bathrooms)}
                            onValueChange={(v) =>
                              handleFormChange('bathrooms', Number(v))
                            }
                          >
                            <SelectTrigger
                              className={selectTriggerClass}
                              aria-invalid={!!errors.bathrooms}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className={selectContentClass}>
                              {[...Array(7).keys()].map((i) => (
                                <SelectItem
                                  key={i}
                                  value={String(i)}
                                  className={selectItemClass}
                                >
                                  {i}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div>
                      <Label htmlFor="sqft">Square Feet</Label>
                      <Input
                        id="sqft"
                        type="number"
                        min={200}
                        step={50}
                        value={form.sqft}
                        onChange={(e) =>
                          handleFormChange('sqft', Number(e.target.value))
                        }
                        className="bg-white"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <Label>Condition Level</Label>
                      <RadioGroup
                        value={form.condition}
                        onValueChange={(v) => handleFormChange('condition', v)}
                        className="flex gap-4 mt-2"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="light" id="light" />
                          <Label htmlFor="light">Light</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="standard" id="standard" />
                          <Label htmlFor="standard">Standard</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="heavy" id="heavy" />
                          <Label htmlFor="heavy">Heavy</Label>
                        </div>
                      </RadioGroup>
                    </div>
                    <div>
                      <Label>Pets on Site?</Label>
                      <RadioGroup
                        value={form.pets}
                        onValueChange={(v) => handleFormChange('pets', v)}
                        className="flex gap-4 mt-2"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="no" id="pet-no" />
                          <Label htmlFor="pet-no">No</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="yes" id="pet-yes" />
                          <Label htmlFor="pet-yes">Yes</Label>
                        </div>
                      </RadioGroup>
                    </div>
                  </div>

                  <div>
                    <Label>Add-ons</Label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 mt-2">
                      {addons.map((addon) => (
                        <div key={addon.id} className="flex items-center space-x-2">
                          <Checkbox
                            id={addon.id}
                            checked={form.addons.includes(addon.id)}
                            onCheckedChange={() => handleAddonToggle(addon.id)}
                          />
                          <Label htmlFor={addon.id} className="cursor-pointer">
                            {addon.name}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Step 4 (Schedule) */}
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle>Step 4: Schedule Date &amp; Time</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className={errors.date ? 'relative' : ''}>
                    <Calendar
                      mode="single"
                      selected={form.date}
                      onSelect={(d) => handleFormChange('date', d)}
                      onMonthChange={setVisibleMonth}
                      disabled={(date) => {
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        return date < today || unavailableDates.has(format(date, 'yyyy-MM-dd'));
                      }}
                      className="rounded-md border bg-white"
                      classNames={{
                        day_selected:
                          'bg-gold text-white hover:bg-gold hover:text-white focus:bg-gold focus:text-white',
                        day_today: 'border border-gold/50',
                        nav_button: 'hover:bg-gold/10',
                      }}
                    />
                    {errors.date && (
                      <p className="text-xs text-red-600 mt-2">{errors.date}</p>
                    )}
                    {loadingDay && (
                      <p className="text-xs text-plum/60 mt-2">
                        Checking availability…
                      </p>
                    )}
                    {!loadingDay && availabilityStatus === 'failed' && (
                      <p className="text-xs text-red-600 mt-2">
                        {availabilityError}
                      </p>
                    )}
                  </div>

                  <div>
                    <Tooltip>
                      <TooltipTrigger className="w-full text-left">
                        <Label>Available Times</Label>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Select a time that works best for you.</p>
                      </TooltipContent>
                    </Tooltip>
                    <p className="text-sm text-plum/70 mb-2">
                      On {form.date ? format(form.date, 'PPP') : 'your selected date'}
                    </p>
                    <RadioGroup
                      value={form.time}
                      onValueChange={(v) => handleFormChange('time', v)}
                      className="grid grid-cols-2 gap-2"
                    >
                      {(!form.date || timeOptionsForUi.length === 0) && (
                        <div className="col-span-2 text-sm text-plum/70">
                          {!form.date
                            ? 'Pick a date to see available times.'
                            : availabilityStatus === 'loading'
                            ? 'Checking availability…'
                            : availabilityStatus === 'failed'
                            ? "We couldn't verify availability right now. Please try again."
                            : day && !day.open
                            ? 'We are closed on this date. Please choose another date.'
                            : 'No time slots are available on this day. Please choose another date.'}
                        </div>
                      )}

                      {timeOptionsForUi.map((time) => {
                        const timeId = `time-${time.replace(/[^a-zA-Z0-9]/g, '')}`;
                        const selected = form.time === time;
                        return (
                          <div key={time}>
                            <RadioGroupItem
                              value={time}
                              id={timeId}
                              className="peer sr-only"
                            />
                            <Label
                              htmlFor={timeId}
                              className={[
                                'block p-3 border-2 rounded-lg text-center transition bg-white cursor-pointer',
                                selected
                                  ? 'border-gold bg-gold/10 ring-2 ring-gold/30'
                                  : 'border-plum/20 hover:border-gold/50',
                              ].join(' ')}
                              aria-pressed={selected}
                              aria-current={selected ? 'true' : undefined}
                            >
                              {time}
                            </Label>
                          </div>
                        );
                      })}
                    </RadioGroup>
                    {errors.time && (
                      <p className="text-xs text-red-600 mt-2">{errors.time}</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Sidebar */}
            <div className="lg:col-span-1 sticky top-24">
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle className="text-plum">Your Estimate</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {estimate.lineItems.filter((li) => li.amount >= 0).map((li) => (
                    <div key={li.label + li.detail} className="flex justify-between text-sm">
                      <span className="text-plum/80">
                        {li.label}
                        {li.detail ? <span className="block text-xs text-plum/60">{li.detail}</span> : null}
                      </span>
                      <span>${li.amount.toFixed(2)}</span>
                    </div>
                  ))}
                  {quoteError && <p className="text-xs text-red-600" role="alert">{quoteError}</p>}
                  <div className="border-t border-gold/30 my-2 pt-2 space-y-2">
                    {estimate.lineItems.filter((li) => li.amount < 0).map((li) => (
                      <div key={li.label + li.detail} className="flex justify-between text-sm font-semibold text-green-700">
                        <span className="flex items-center">
                          <Tag className="h-4 w-4 mr-1" />
                          {li.label}{li.detail ? ` (${li.detail})` : ''}
                        </span>
                        <span>−${Math.abs(li.amount).toFixed(2)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between font-bold text-plum mt-1">
                      <span className="flex items-center text-lg">
                        <Clock className="h-5 w-5 mr-2 text-gold" />
                        Est. Duration
                      </span>
                      <span>~{estimate.duration} hours</span>
                    </div>
                    <div className="flex justify-between text-2xl font-bold text-plum">
                      <span>Total</span>
                      <span>${estimate.total.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="text-xs text-plum/70 pt-2 flex items-start gap-1">
                    <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <span>Final price may adjust on site after walkthrough.</span>
                  </div>
                  <div className="sr-only" aria-live="polite" ref={estimateLiveRef} />
                </CardContent>
                <CardFooter className="flex flex-col gap-4">
                  <div className="flex w-full max-w-sm items-center space-x-2">
                    <Label htmlFor="promo-code" className="sr-only">Promo code</Label>
                    <Input
                      id="promo-code"
                      type="text"
                      name="promoCode"
                      placeholder="Promo Code"
                      value={form.promoCode}
                      onChange={(e) => {
                        handleFormChange('promoCode', e.target.value);
                        if (promoApplied) setPromoApplied(false);
                      }}
                      autoComplete="off"
                      className="bg-white"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleApplyPromoCode}
                      className="border-gold text-gold hover:bg-gold/10 hover:text-gold"
                      disabled={!form.promoCode?.trim() || promoApplied}
                    >
                      {promoApplied ? 'Applied' : 'Apply'}
                    </Button>
                  </div>

                  {/* ⚖️ Disclaimer before the button */}
                  <div className="rounded-xl border border-gold/30 bg-rose-50 p-4 -mt-1">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-gold mt-0.5" />
                      <div className="text-sm text-plum/80">
                        <p className="font-semibold text-plum">
                          Important: estimates are not final quotes.
                        </p>
                        <ul className="list-disc pl-5 mt-2 space-y-1">
                          <li>
                            The online total is an estimate. Final pricing is confirmed
                            after we physically see the property and walk through the
                            scope.
                          </li>
                          <li>
                            A <span className="font-semibold">${(rules?.depositAmount ?? 50).toFixed(0)} non-refundable deposit</span> is paid online to hold your appointment. It is
                            applied to your final balance. Card payments include a processing fee shown at checkout.
                          </li>
                          <li>
                            <span className="font-semibold">Timing:</span> your time slot is held for {rules?.holdMinutes ?? 30} minutes while you complete the deposit payment.
                          </li>
                          <li>
                            <span className="font-semibold">Rescheduling and cancellations:</span> you can reschedule or cancel from your account up to {rules?.changeCutoffHours ?? 24} hours before your appointment. Within {rules?.changeCutoffHours ?? 24} hours, please contact us; late cancellations or lock-outs may forfeit the deposit.
                          </li>
                          <li>
                            If the size or condition differs from what was submitted, the
                            price and duration will be adjusted on site before work
                            begins.
                          </li>
                        </ul>
                        <label className="mt-3 flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={form.agreePolicy}
                            onChange={(e) =>
                              handleFormChange('agreePolicy', e.target.checked)
                            }
                            className="h-4 w-4 rounded border-plum/30 accent-[--gold-500]"
                          />
                          <span>
                            I understand and agree to the estimate and deposit policy.
                          </span>
                        </label>
                        {errors.agreePolicy && (
                          <p className="text-xs text-red-600 mt-1">
                            {errors.agreePolicy}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    onClick={handleProceedToCheckout}
                    size="lg"
                    className="w-full bg-gold hover:bg-gold/90 text-white rounded-full disabled:opacity-60 flex items-center justify-center gap-2"
                    disabled={isSubmitting || !quote}
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        <span>{isEditing ? "Saving…" : "Connecting to Stripe…"}</span>
                      </>
                    ) : (
                      <>
                        <span>{isEditing ? "Save New Date/Time" : "Proceed to Book"}</span>
                        <ChevronRight className="h-5 w-5" />
                      </>
                    )}
                  </Button>
                </CardFooter>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};

export default BookingPage;
