import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseYCloudEvent, normalizeEmbeddedSignupInput, parseExpiresAtMs } from "./ycloud";

describe("parseYCloudEvent inbound image", () => {
  it("extracts image link, caption, and mime type", () => {
    const parsed = parseYCloudEvent({
      id: "evt_img_1",
      type: "whatsapp.inbound_message.received",
      whatsappInboundMessage: {
        id: "wim_img_1",
        from: "+85290000000",
        to: "+85251111111",
        type: "image",
        image: {
          id: "592623615738103",
          link: "https://api.ycloud.com/v2/whatsapp/media/download/592623615738103",
          caption: "Go for a walk.",
          mime_type: "image/jpeg",
        },
      },
    });

    assert.equal(parsed?.type, "whatsapp.inbound_message.received");
    assert.equal(parsed?.inbound?.messageType, "image");
    assert.equal(parsed?.inbound?.text, "Go for a walk.");
    assert.equal(parsed?.inbound?.media?.kind, "image");
    assert.equal(parsed?.inbound?.media?.id, "592623615738103");
    assert.equal(
      parsed?.inbound?.media?.link,
      "https://api.ycloud.com/v2/whatsapp/media/download/592623615738103",
    );
    assert.equal(parsed?.inbound?.media?.caption, "Go for a walk.");
    assert.equal(parsed?.inbound?.media?.mimeType, "image/jpeg");
  });

  it("parses image without caption", () => {
    const parsed = parseYCloudEvent({
      id: "evt_img_2",
      type: "whatsapp.inbound_message.received",
      whatsappInboundMessage: {
        id: "wim_img_2",
        from: "+85290000000",
        to: "+85251111111",
        type: "image",
        image: {
          id: "media_2",
          link: "https://api.ycloud.com/v2/whatsapp/media/download/media_2",
          mimeType: "image/png",
        },
      },
    });

    assert.equal(parsed?.inbound?.messageType, "image");
    assert.equal(parsed?.inbound?.text, undefined);
    assert.equal(parsed?.inbound?.media?.caption, undefined);
    assert.equal(parsed?.inbound?.media?.mimeType, "image/png");
  });

  it("still parses text messages", () => {
    const parsed = parseYCloudEvent({
      id: "evt_text_1",
      type: "whatsapp.inbound_message.received",
      whatsappInboundMessage: {
        id: "wim_text_1",
        from: "+85290000000",
        to: "+85251111111",
        type: "text",
        text: { body: "你好" },
      },
    });

    assert.equal(parsed?.inbound?.messageType, "text");
    assert.equal(parsed?.inbound?.text, "你好");
    assert.equal(parsed?.inbound?.media, undefined);
  });
});

describe("parseYCloudEvent WABA updated", () => {
  it("extracts PARTNER_ADDED binding fields", () => {
    const parsed = parseYCloudEvent({
      id: "evt_6a990157f7a61232eb60000a",
      type: "whatsapp.business_account.updated",
      apiVersion: "v2",
      createTime: "2026-09-03T05:10:47.773Z",
      whatsappBusinessAccount: {
        id: "WABA_1",
        name: "Acme WABA",
        businessId: "BIZ_1",
        businessName: "Acme",
        accountReviewStatus: "APPROVED",
        businessVerificationStatus: "verified",
        whatsappBusinessManagerMessagingLimit: "TIER_2K",
        ownershipType: "CLIENT_OWNED",
        updateEvent: "PARTNER_ADDED",
        paymentMethodAttached: true,
        partnerCustomerId: "test_customer_001",
      },
    });

    assert.equal(parsed?.type, "whatsapp.business_account.updated");
    assert.equal(parsed?.wabaUpdate?.eventId, "evt_6a990157f7a61232eb60000a");
    assert.equal(parsed?.wabaUpdate?.updateEvent, "PARTNER_ADDED");
    assert.equal(parsed?.wabaUpdate?.wabaId, "WABA_1");
    assert.equal(parsed?.wabaUpdate?.wabaName, "Acme WABA");
    assert.equal(parsed?.wabaUpdate?.partnerCustomerId, "test_customer_001");
    assert.equal(parsed?.wabaUpdate?.paymentMethodAttached, true);
    assert.equal(parsed?.wabaUpdate?.messagingLimit, "TIER_2K");
    assert.equal(parsed?.inbound, undefined);
    assert.equal(parsed?.update, undefined);
  });
});

describe("normalizeEmbeddedSignupInput", () => {
  it("requires MIO_CDP_SUPPLIER_ID when request omits partnerCustomerId", () => {
    const result = normalizeEmbeddedSignupInput({});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /MIO_CDP_SUPPLIER_ID/);
  });

  it("uses MIO_CDP_SUPPLIER_ID over a request id", () => {
    const result = normalizeEmbeddedSignupInput(
      { partnerCustomerId: "test_onboard_001" },
      { defaultPartnerCustomerId: "supplier_from_env" },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.partnerCustomerId, "supplier_from_env");
    assert.equal(result.partnerCustomerIdSource, "MIO_CDP_SUPPLIER_ID");
    assert.equal(result.onboardingType, "WHATSAPP_BUSINESS_PLATFORM");
  });

  it("rejects invalid locale and type", () => {
    const locale = normalizeEmbeddedSignupInput({ partnerCustomerId: "c1", locale: "zh" });
    assert.equal(locale.ok, false);
    const type = normalizeEmbeddedSignupInput({ partnerCustomerId: "c1", onboardingType: "SMS" });
    assert.equal(type.ok, false);
  });

  it("keeps a valid locale from the request when env is absent", () => {
    const result = normalizeEmbeddedSignupInput({
      partnerCustomerId: "customer_001",
      locale: "zh_CN",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.partnerCustomerIdSource, "request");
    assert.equal(result.partnerCustomerId, "customer_001");
    assert.equal(result.locale, "zh_CN");
  });
});

describe("parseExpiresAtMs", () => {
  it("parses ISO datetime from YCloud", () => {
    assert.equal(parseExpiresAtMs("2026-09-03T09:27:06.675Z"), Date.parse("2026-09-03T09:27:06.675Z"));
  });

  it("parses unix milliseconds and seconds", () => {
    assert.equal(parseExpiresAtMs(1788155472249), 1788155472249);
    assert.equal(parseExpiresAtMs(1788155472), 1788155472000);
  });
});
