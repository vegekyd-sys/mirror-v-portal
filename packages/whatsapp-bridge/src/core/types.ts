export type InboundMedia = {
  kind: "image";
  id?: string;
  link?: string;
  mimeType?: string;
  caption?: string;
};

export type NormalizedInbound = {
  eventId: string;
  ycloudMessageId?: string;
  wamid?: string;
  customerPhone: string;
  businessPhone: string;
  whatsappUserId?: string;
  whatsappParentUserId?: string;
  customerName?: string;
  messageType: string;
  text?: string;
  media?: InboundMedia;
  sendTime?: string;
};

export type DeliveryUpdate = {
  eventId: string;
  ycloudMessageId: string;
  wamid?: string;
  status: string;
  expireTime?: string;
  errorCode?: string;
  errorMessage?: string;
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
};

/** YCloud `whatsapp.business_account.updated`（嵌入式注册绑定等）。 */
export type WabaAccountUpdate = {
  eventId: string;
  wabaId?: string;
  wabaName?: string;
  phoneNumberId?: string;
  businessId?: string;
  businessName?: string;
  accountReviewStatus?: string;
  businessVerificationStatus?: string;
  ownershipType?: string;
  messagingLimit?: string;
  paymentMethodAttached?: boolean;
  updateEvent?: string;
  partnerCustomerId?: string;
};

export type ThreadRef = {
  chatId: string;
  threadId: string;
  rootMessageId: string;
  /** 刚建话题时，第一条回复的飞书 message_id */
  firstReplyMessageId?: string;
};

export type EnsureThreadInput = {
  conversationId: string;
  customerPhone: string;
  businessPhone: string;
  customerName?: string;
  customerAlias?: string;
  firstText: string;
  /** 拉进客服群的用户 open_id（例如智能体发起人） */
  memberOpenIds?: string[];
  /** 拉进客服群的其它机器人 App ID（FEISHU_INVITE_APP_IDS） */
  botAppIds?: string[];
};
