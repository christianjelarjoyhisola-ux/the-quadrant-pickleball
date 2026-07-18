-- Temporary browser reservations must stop occupying a slot after 15 minutes,
-- even when an older client accidentally saved the placeholder as `pending`.

UPDATE public.bookings
SET status = 'cancelled', payment_status = 'rejected'
WHERE lower(coalesce(email, '')) = 'reserve@hold.internal'
  AND lower(coalesce(status, '')) IN ('pending', 'verifying')
  AND created_at IS NOT NULL
  AND created_at <= (now() - interval '15 minutes');

CREATE OR REPLACE FUNCTION public.prevent_double_booking()
RETURNS TRIGGER AS $$
DECLARE
  new_status text := lower(coalesce(NEW.status, ''));
  new_payment_status text := lower(coalesce(NEW.payment_status, ''));
BEGIN
  IF new_status = 'cancelled' THEN RETURN NEW; END IF;
  IF new_payment_status IN ('failed', 'rejected', 'cancelled', 'canceled', 'expired') THEN RETURN NEW; END IF;

  IF new_payment_status = 'unpaid'
    AND (NEW.payment_provider IS NOT NULL OR NEW.payment_session_id IS NOT NULL OR NEW.payment_checkout_url IS NOT NULL)
    AND new_status NOT IN ('confirmed', 'completed') THEN
    RETURN NEW;
  END IF;

  IF new_status NOT IN ('pending', 'verifying', 'confirmed', 'completed') THEN RETURN NEW; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.court_id = NEW.court_id
      AND b.date = NEW.date
      AND b.ref != NEW.ref
      AND b.slots && NEW.slots
      AND lower(coalesce(b.status, '')) IN ('pending', 'verifying', 'confirmed', 'completed')
      AND lower(coalesce(b.payment_status, '')) NOT IN ('failed', 'rejected', 'cancelled', 'canceled', 'expired')
      AND NOT (
        lower(coalesce(b.payment_status, '')) = 'unpaid'
        AND (b.payment_provider IS NOT NULL OR b.payment_session_id IS NOT NULL OR b.payment_checkout_url IS NOT NULL)
        AND lower(coalesce(b.status, '')) NOT IN ('confirmed', 'completed')
      )
      AND (
        (
          lower(coalesce(b.status, '')) != 'verifying'
          AND lower(coalesce(b.email, '')) != 'reserve@hold.internal'
        )
        OR b.created_at IS NULL
        OR b.created_at > (now() - interval '15 minutes')
      )
  ) THEN
    RAISE EXCEPTION 'One or more time slots are already booked for this court and date.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
