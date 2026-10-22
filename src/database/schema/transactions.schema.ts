
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  bigint,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const transactionStatus = pgEnum(
  "transaction_status",
  [
    "PENDING",
    "AUTHORIZED",
    "FAILED",
    "CANCELLED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
  ],
);

export const paymentProvider = pgEnum(
  "payment_provider",
  ["TRANSBANK"],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id").notNull(),

    externalReference: varchar("external_reference", {
      length: 100,
    }).notNull(),

    idempotencyKey: varchar("idempotency_key", {
      length: 100,
    }).notNull(),

    amount: bigint("amount", {
      mode: "bigint",
    }).notNull(),

    currency: varchar("currency", {
      length: 3,
    }).notNull().default("CLP"),

    status: transactionStatus("status")
      .notNull()
      .default("PENDING"),

    createdAt: timestamp("created_at")
      .defaultNow()
      .notNull(),

    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("transactions_tenant_reference_uq")
      .on(table.tenantId, table.externalReference),

    uniqueIndex("transactions_tenant_idempotency_uq")
      .on(table.tenantId, table.idempotencyKey),

    index("transactions_status_idx")
      .on(table.status),
  ],
);

export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id),

    provider: paymentProvider("provider")
      .notNull(),

    providerOrderId: varchar("provider_order_id", {
      length: 100,
    }).notNull(),

    providerTransactionId: varchar("provider_transaction_id", {
      length: 100,
    }),

    status: varchar("status", {
      length: 30,
    }).notNull().default("CREATED"),

    createdAt: timestamp("created_at")
      .defaultNow()
      .notNull(),

    updatedAt: timestamp("updated_at")
    
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("payment_attempts_transaction_idx")
      .on(table.transactionId),

    uniqueIndex("payment_attempts_provider_order_uq")
      .on(table.provider, table.providerOrderId),
  ],
);
