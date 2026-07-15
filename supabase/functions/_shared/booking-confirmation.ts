type BookingConfirmationRow = {
  ref: string;
  booking_group_ref: string | null;
  full_name: string | null;
  email: string | null;
  contact_number: string | null;
  court_name: string | null;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  duration: number | string | null;
  total: number | string | null;
  downpayment: number | string | null;
};

export async function sendPaidBookingConfirmation(
  db: any,
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingRef: string,
) {
  const columns = "ref,booking_group_ref,full_name,email,contact_number,court_name,date,start_time,end_time,duration,total,downpayment";
  const { data: primaryData, error: primaryErr } = await db
    .from("bookings")
    .select(columns)
    .eq("ref", bookingRef)
    .single();
  if (primaryErr) throw primaryErr;
  const primary = primaryData as BookingConfirmationRow;
  if (!primary?.email || primary.email === "reserve@hold.internal") {
    throw new Error("Paid booking has no deliverable customer email");
  }

  let rows: BookingConfirmationRow[] = [primary];
  if (primary.booking_group_ref) {
    const { data: groupData, error: groupErr } = await db
      .from("bookings")
      .select(columns)
      .eq("booking_group_ref", primary.booking_group_ref)
      .neq("status", "cancelled")
      .order("date")
      .order("start_time");
    if (groupErr) throw groupErr;
    if (groupData?.length) rows = groupData as BookingConfirmationRow[];
  }

  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const downpayment = rows.reduce((sum, row) => sum + Number(row.downpayment || 0), 0);
  const payload = {
    bookingRef: primary.booking_group_ref || primary.ref,
    email: primary.email,
    fullName: primary.full_name || "Customer",
    contactNumber: primary.contact_number || "",
    courtName: [...new Set(rows.map((row) => row.court_name).filter(Boolean))].join(", "),
    date: primary.date || "",
    startTime: primary.start_time || "",
    endTime: primary.end_time || "",
    duration: rows.reduce((sum, row) => sum + Number(row.duration || 0), 0),
    total,
    downpayment,
    paymentMethod: "qrph",
    bookingItems: rows.map((row) => ({
      courtName: row.court_name || "Court",
      date: row.date || "",
      startTime: row.start_time || "",
      endTime: row.end_time || "",
      duration: Number(row.duration || 0),
      total: Number(row.total || 0),
      downpayment: Number(row.downpayment || 0),
    })),
    idempotencyKey: `booking-confirmation-${primary.booking_group_ref || primary.ref}`,
  };

  const response = await fetch(`${supabaseUrl}/functions/v1/send-confirmation-email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Confirmation email failed ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
