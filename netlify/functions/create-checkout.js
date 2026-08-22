// Creates a Square Payment Link on the fly, pre-filled with the lead's name/email/phone,
// so the customer never has to retype what they already gave us on the landing page.
//
// Reads the Square token from the SQUARE_ACCESS_TOKEN environment variable (set in
// Netlify's Site configuration -> Environment variables). Never hardcode the token here.

const SITE_URL = "https://storied-figolla-9f1e75.netlify.app";
const SQUARE_API_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2025-01-23";

// Square requires E.164 (e.g. +14161231234). Visitors type all sorts of
// formats ("416-123-1234", "(416) 123-1234", "4161231234") — normalize
// North American numbers so Square doesn't reject the whole request over
// one field. Returns null (omit the field) if it doesn't look salvageable.
function toE164(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 7) return `+${digits}`; // best-effort for non-NA numbers
  return null;
}

export default async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }

  try {
    const { name, email, phone, offer } = await req.json();

    if (!email || !offer) {
      return new Response(JSON.stringify({ error: "Missing email or offer" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    const token = process.env.SQUARE_ACCESS_TOKEN;
    if (!token) {
      console.error("create-checkout: SQUARE_ACCESS_TOKEN is not set — falling back to static link");
      return new Response(JSON.stringify({ error: "Server not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    const isPackage = String(offer).indexOf("249") !== -1;
    const itemName = isPackage
      ? "Red Light Therapy - 4-Session Package"
      : "Red Light Therapy - First Visit";
    const amount = isPackage ? 24900 : 6700; // cents
    const paidParam = isPackage ? "249" : "67";

    const squareHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_VERSION,
    };

    // 1. Get the location ID for this account (needed on every payment link).
    // Prefer the env var — it never changes, and skipping this lookup saves a full
    // round trip on every submit, which matters against the client's safety timeout.
    // Falls back to the API lookup so nothing breaks if the env var isn't set yet.
    let locationId = process.env.SQUARE_LOCATION_ID;
    if (!locationId) {
      const locRes = await fetch(`${SQUARE_API_BASE}/locations`, { headers: squareHeaders });
      const locData = await locRes.json();
      locationId = locData && locData.locations && locData.locations[0] && locData.locations[0].id;

      if (!locRes.ok || !locationId) {
        console.error("create-checkout: could not resolve Square location", locData);
        return new Response(JSON.stringify({ error: "Could not resolve Square location", details: locData }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }

    // 2. Create a one-off payment link, pre-filled with what the lead already gave us.
    const redirectUrl = `${SITE_URL}/thankyou.html?paid=${paidParam}`;

    // Split "Full Name" into first/last so Square's Contact section can pre-fill both fields.
    const nameParts = String(name || "").trim().split(/\s+/).filter(Boolean);
    const givenName = nameParts[0] || "";
    const familyName = nameParts.slice(1).join(" ");

    const buildBody = (phoneE164) => ({
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: itemName,
        price_money: { amount, currency: "CAD" },
        location_id: locationId,
      },
      checkout_options: {
        redirect_url: redirectUrl,
      },
      pre_populated_data: {
        buyer_email: email,
        ...(phoneE164 ? { buyer_phone_number: phoneE164 } : {}),
        ...(givenName
          ? { buyer_address: { first_name: givenName, ...(familyName ? { last_name: familyName } : {}) } }
          : {}),
      },
    });

    const createLink = (body) =>
      fetch(`${SQUARE_API_BASE}/online-checkout/payment-links`, {
        method: "POST",
        headers: squareHeaders,
        body: JSON.stringify(body),
      });

    let linkRes = await createLink(buildBody(toE164(phone)));
    let linkData = await linkRes.json();

    // If Square still rejects the phone number specifically (a format we didn't
    // anticipate), retry once without it rather than losing the whole checkout
    // link — a pre-filled email is far better than falling back to the generic
    // static link with nothing pre-filled at all.
    const phoneRejected =
      !linkRes.ok &&
      Array.isArray(linkData?.errors) &&
      linkData.errors.some((e) => e.field === "pre_populated_data.buyer_phone_number");

    if (phoneRejected) {
      console.error("create-checkout: Square rejected the phone number, retrying without it", linkData);
      linkRes = await createLink(buildBody(null));
      linkData = await linkRes.json();
    }

    if (!linkRes.ok || !linkData.payment_link || !linkData.payment_link.url) {
      console.error("create-checkout: Square rejected the payment-link request", linkData);
      return new Response(JSON.stringify({ error: "Square rejected the request", details: linkData }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    return new Response(JSON.stringify({ url: linkData.payment_link.url }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...cors },
    });
  } catch (err) {
    console.error("create-checkout: unhandled error", err);
    return new Response(JSON.stringify({ error: "Server error", message: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
};
