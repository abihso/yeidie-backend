CREATE TABLE "availability_slots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"counsellor_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "availability_time_check" CHECK ("availability_slots"."ends_at" > "availability_slots"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slot_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"counsellor_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" varchar(2000) DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_status_check" CHECK ("bookings"."status" in ('pending', 'confirmed', 'cancelled', 'completed')),
	CONSTRAINT "bookings_participants_check" CHECK ("bookings"."client_id" <> "bookings"."counsellor_id")
);
--> statement-breakpoint
CREATE TABLE "call_rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid,
	"booking_id" uuid,
	"created_by" uuid NOT NULL,
	"mode" text DEFAULT 'video' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "call_rooms_mode_check" CHECK ("call_rooms"."mode" in ('audio', 'video')),
	CONSTRAINT "call_rooms_target_check" CHECK (("call_rooms"."conversation_id" is not null and "call_rooms"."booking_id" is null) or ("call_rooms"."conversation_id" is null and "call_rooms"."booking_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_members_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id"),
	CONSTRAINT "conversation_members_role_check" CHECK ("conversation_members"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" varchar(120),
	"created_by" uuid NOT NULL,
	"direct_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_kind_check" CHECK ("conversations"."kind" in ('direct', 'group')),
	CONSTRAINT "conversations_direct_key_check" CHECK (("conversations"."kind" = 'direct' and "conversations"."direct_key" is not null) or ("conversations"."kind" = 'group' and "conversations"."direct_key" is null))
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"following_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_following_id_pk" PRIMARY KEY("follower_id","following_id"),
	CONSTRAINT "follows_self_check" CHECK ("follows"."follower_id" <> "follows"."following_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" varchar(4000) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_body_check" CHECK (length(trim("messages"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" json NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" varchar(120) NOT NULL,
	"email" varchar(254) NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"bio" varchar(2000) DEFAULT '' NOT NULL,
	"specialties" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('client', 'counsellor'))
);
--> statement-breakpoint
ALTER TABLE "availability_slots" ADD CONSTRAINT "availability_slots_counsellor_id_users_id_fk" FOREIGN KEY ("counsellor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_slot_id_availability_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."availability_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_counsellor_id_users_id_fk" FOREIGN KEY ("counsellor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_rooms" ADD CONSTRAINT "call_rooms_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_rooms" ADD CONSTRAINT "call_rooms_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_rooms" ADD CONSTRAINT "call_rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_following_id_users_id_fk" FOREIGN KEY ("following_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_counsellor_time" ON "availability_slots" USING btree ("counsellor_id","starts_at") WHERE "availability_slots"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_booking_per_slot" ON "bookings" USING btree ("slot_id") WHERE "bookings"."status" in ('pending', 'confirmed');--> statement-breakpoint
CREATE INDEX "bookings_client" ON "bookings" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "bookings_counsellor" ON "bookings" USING btree ("counsellor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_conversation_call" ON "call_rooms" USING btree ("conversation_id") WHERE "call_rooms"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_booking_call" ON "call_rooms" USING btree ("booking_id") WHERE "call_rooms"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "conversation_members_user" ON "conversation_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_direct_key_unique" ON "conversations" USING btree ("direct_key");--> statement-breakpoint
CREATE INDEX "follows_following" ON "follows" USING btree ("following_id");--> statement-breakpoint
CREATE INDEX "messages_history" ON "messages" USING btree ("conversation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "user_sessions_expire" ON "user_sessions" USING btree ("expire");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");