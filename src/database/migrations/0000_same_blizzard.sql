CREATE TYPE "public"."payment_provider" AS ENUM('TRANSBANK');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('PENDING', 'AUTHORIZED', 'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED');--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_order_id" varchar(100) NOT NULL,
	"provider_transaction_id" varchar(100),
	"status" varchar(30) DEFAULT 'CREATED' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_reference" varchar(100) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"amount" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'CLP' NOT NULL,
	"status" "transaction_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_attempts_transaction_idx" ON "payment_attempts" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_provider_order_uq" ON "payment_attempts" USING btree ("provider","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_tenant_reference_uq" ON "transactions" USING btree ("tenant_id","external_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_tenant_idempotency_uq" ON "transactions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "transactions_status_idx" ON "transactions" USING btree ("status");