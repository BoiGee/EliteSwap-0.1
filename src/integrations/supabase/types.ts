export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_deletion_requests: {
        Row: {
          cancelled_at: string | null
          created_at: string
          email: string | null
          id: string
          notes: string | null
          purge_after: string
          purged_at: string | null
          requested_at: string
          requested_by: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cancelled_at?: string | null
          created_at?: string
          email?: string | null
          id?: string
          notes?: string | null
          purge_after?: string
          purged_at?: string | null
          requested_at?: string
          requested_by: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cancelled_at?: string | null
          created_at?: string
          email?: string | null
          id?: string
          notes?: string | null
          purge_after?: string
          purged_at?: string | null
          requested_at?: string
          requested_by?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_audit_logs: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          actor_role: string | null
          after_data: Json | null
          before_data: Json | null
          created_at: string
          id: string
          metadata: Json | null
          target_id: string | null
          target_type: string
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          actor_role?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id?: string | null
          target_type: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          actor_role?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id?: string | null
          target_type?: string
        }
        Relationships: []
      }
      admin_push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          failure_count: number
          id: string
          last_seen_at: string
          last_success_at: string | null
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          failure_count?: number
          id?: string
          last_seen_at?: string
          last_success_at?: string | null
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          failure_count?: number
          id?: string
          last_seen_at?: string
          last_success_at?: string | null
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      announcement_views: {
        Row: {
          announcement_id: string
          first_viewed_at: string
          id: string
          last_viewed_at: string
          user_id: string
          view_count: number
        }
        Insert: {
          announcement_id: string
          first_viewed_at?: string
          id?: string
          last_viewed_at?: string
          user_id: string
          view_count?: number
        }
        Update: {
          announcement_id?: string
          first_viewed_at?: string
          id?: string
          last_viewed_at?: string
          user_id?: string
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "announcement_views_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "system_announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      api_key_pool: {
        Row: {
          api_key: string
          assigned_at: string | null
          assigned_payment_id: string | null
          assigned_to_user_id: string | null
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          plan_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          api_key: string
          assigned_at?: string | null
          assigned_payment_id?: string | null
          assigned_to_user_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          plan_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          api_key?: string
          assigned_at?: string | null
          assigned_payment_id?: string | null
          assigned_to_user_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          plan_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      api_key_secrets: {
        Row: {
          api_key_id: string
          created_at: string
          decart_key: string
          updated_at: string
        }
        Insert: {
          api_key_id: string
          created_at?: string
          decart_key: string
          updated_at?: string
        }
        Update: {
          api_key_id?: string
          created_at?: string
          decart_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_key_secrets_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: true
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          active_session_id: string | null
          active_session_started_at: string | null
          assigned_at: string | null
          created_at: string
          expires_at: string | null
          id: string
          is_active: boolean
          key: string
          label: string | null
          last_session_ended_at: string | null
          payment_id: string | null
          pool_key_id: string | null
          remaining_ms: number | null
          user_id: string
        }
        Insert: {
          active_session_id?: string | null
          active_session_started_at?: string | null
          assigned_at?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          key?: string
          label?: string | null
          last_session_ended_at?: string | null
          payment_id?: string | null
          pool_key_id?: string | null
          remaining_ms?: number | null
          user_id: string
        }
        Update: {
          active_session_id?: string | null
          active_session_started_at?: string | null
          assigned_at?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          key?: string
          label?: string | null
          last_session_ended_at?: string | null
          payment_id?: string | null
          pool_key_id?: string | null
          remaining_ms?: number | null
          user_id?: string
        }
        Relationships: []
      }
      app_notifications: {
        Row: {
          actor_id: string | null
          body: string | null
          category: string
          created_at: string
          data: Json
          dismissed_at: string | null
          href: string | null
          id: string
          kind: string
          read_at: string | null
          severity: string
          target_id: string | null
          target_kind: string | null
          title: string
          user_id: string
        }
        Insert: {
          actor_id?: string | null
          body?: string | null
          category: string
          created_at?: string
          data?: Json
          dismissed_at?: string | null
          href?: string | null
          id?: string
          kind: string
          read_at?: string | null
          severity?: string
          target_id?: string | null
          target_kind?: string | null
          title: string
          user_id: string
        }
        Update: {
          actor_id?: string | null
          body?: string | null
          category?: string
          created_at?: string
          data?: Json
          dismissed_at?: string | null
          href?: string | null
          id?: string
          kind?: string
          read_at?: string | null
          severity?: string
          target_id?: string | null
          target_kind?: string | null
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      backup_runs: {
        Row: {
          auth_user_count: number | null
          created_at: string
          download_url: string | null
          error_message: string | null
          extras_ok: Json | null
          file_size_bytes: number | null
          finished_at: string | null
          id: string
          schema_ddl_bytes: number | null
          started_at: string
          status: string
          storage_bytes: number | null
          storage_file_count: number | null
          storage_path: string | null
          table_count: number | null
          total_rows: number | null
          triggered_by: string
        }
        Insert: {
          auth_user_count?: number | null
          created_at?: string
          download_url?: string | null
          error_message?: string | null
          extras_ok?: Json | null
          file_size_bytes?: number | null
          finished_at?: string | null
          id?: string
          schema_ddl_bytes?: number | null
          started_at?: string
          status?: string
          storage_bytes?: number | null
          storage_file_count?: number | null
          storage_path?: string | null
          table_count?: number | null
          total_rows?: number | null
          triggered_by?: string
        }
        Update: {
          auth_user_count?: number | null
          created_at?: string
          download_url?: string | null
          error_message?: string | null
          extras_ok?: Json | null
          file_size_bytes?: number | null
          finished_at?: string | null
          id?: string
          schema_ddl_bytes?: number | null
          started_at?: string
          status?: string
          storage_bytes?: number | null
          storage_file_count?: number | null
          storage_path?: string | null
          table_count?: number | null
          total_rows?: number | null
          triggered_by?: string
        }
        Relationships: []
      }
      broadcast_recipients: {
        Row: {
          broadcast_id: string
          created_at: string
          display_name: string | null
          email: string
          error_message: string | null
          id: string
          send_status: string
          suppressed: boolean
          user_id: string | null
        }
        Insert: {
          broadcast_id: string
          created_at?: string
          display_name?: string | null
          email: string
          error_message?: string | null
          id?: string
          send_status?: string
          suppressed?: boolean
          user_id?: string | null
        }
        Update: {
          broadcast_id?: string
          created_at?: string
          display_name?: string | null
          email?: string
          error_message?: string | null
          id?: string
          send_status?: string
          suppressed?: boolean
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "broadcast_recipients_broadcast_id_fkey"
            columns: ["broadcast_id"]
            isOneToOne: false
            referencedRelation: "broadcasts"
            referencedColumns: ["id"]
          },
        ]
      }
      broadcasts: {
        Row: {
          body_md: string
          completed_at: string | null
          created_at: string
          created_by: string
          cta_label: string | null
          cta_url: string | null
          enqueued_count: number
          error_message: string | null
          failed_count: number
          filter_preset: string | null
          id: string
          recipient_mode: string
          recipient_user_ids: string[] | null
          scheduled_for: string | null
          started_at: string | null
          status: string
          subject: string
          suppressed_count: number
          total_matched: number
          updated_at: string
        }
        Insert: {
          body_md: string
          completed_at?: string | null
          created_at?: string
          created_by: string
          cta_label?: string | null
          cta_url?: string | null
          enqueued_count?: number
          error_message?: string | null
          failed_count?: number
          filter_preset?: string | null
          id?: string
          recipient_mode: string
          recipient_user_ids?: string[] | null
          scheduled_for?: string | null
          started_at?: string | null
          status?: string
          subject: string
          suppressed_count?: number
          total_matched?: number
          updated_at?: string
        }
        Update: {
          body_md?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string
          cta_label?: string | null
          cta_url?: string | null
          enqueued_count?: number
          error_message?: string | null
          failed_count?: number
          filter_preset?: string | null
          id?: string
          recipient_mode?: string
          recipient_user_ids?: string[] | null
          scheduled_for?: string | null
          started_at?: string | null
          status?: string
          subject?: string
          suppressed_count?: number
          total_matched?: number
          updated_at?: string
        }
        Relationships: []
      }
      discount_codes: {
        Row: {
          applies_to_plan_ids: string[] | null
          code: string
          created_at: string
          created_by: string | null
          description: string | null
          expires_at: string | null
          id: string
          is_active: boolean
          max_redemptions: number | null
          percent_off: number
          redemption_mode: string
          times_redeemed: number
          updated_at: string
        }
        Insert: {
          applies_to_plan_ids?: string[] | null
          code: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_redemptions?: number | null
          percent_off: number
          redemption_mode: string
          times_redeemed?: number
          updated_at?: string
        }
        Update: {
          applies_to_plan_ids?: string[] | null
          code?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_redemptions?: number | null
          percent_off?: number
          redemption_mode?: string
          times_redeemed?: number
          updated_at?: string
        }
        Relationships: []
      }
      discount_redemptions: {
        Row: {
          code_id: string
          discount_amount_usd: number
          id: string
          payment_id: string | null
          redeemed_at: string
          user_id: string
        }
        Insert: {
          code_id: string
          discount_amount_usd: number
          id?: string
          payment_id?: string | null
          redeemed_at?: string
          user_id: string
        }
        Update: {
          code_id?: string
          discount_amount_usd?: number
          id?: string
          payment_id?: string | null
          redeemed_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discount_redemptions_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "discount_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
        }
        Relationships: []
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      expense_categories: {
        Row: {
          created_at: string
          id: string
          is_archived: boolean
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_archived?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_archived?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      forum_badges: {
        Row: {
          awarded_at: string
          code: string
          id: string
          user_id: string
        }
        Insert: {
          awarded_at?: string
          code: string
          id?: string
          user_id: string
        }
        Update: {
          awarded_at?: string
          code?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      forum_categories: {
        Row: {
          access_level: Database["public"]["Enums"]["forum_access_level"]
          created_at: string
          description: string | null
          icon: string | null
          id: string
          is_active: boolean
          name: string
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          access_level?: Database["public"]["Enums"]["forum_access_level"]
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name: string
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          access_level?: Database["public"]["Enums"]["forum_access_level"]
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      forum_media: {
        Row: {
          bytes: number
          created_at: string
          duration_ms: number | null
          height: number | null
          id: string
          kind: Database["public"]["Enums"]["forum_media_kind"]
          mime: string
          owner_id: string
          reject_reason: string | null
          reply_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["forum_media_status"]
          storage_path: string
          thread_id: string | null
          width: number | null
        }
        Insert: {
          bytes: number
          created_at?: string
          duration_ms?: number | null
          height?: number | null
          id?: string
          kind: Database["public"]["Enums"]["forum_media_kind"]
          mime: string
          owner_id: string
          reject_reason?: string | null
          reply_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["forum_media_status"]
          storage_path: string
          thread_id?: string | null
          width?: number | null
        }
        Update: {
          bytes?: number
          created_at?: string
          duration_ms?: number | null
          height?: number | null
          id?: string
          kind?: Database["public"]["Enums"]["forum_media_kind"]
          mime?: string
          owner_id?: string
          reject_reason?: string | null
          reply_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["forum_media_status"]
          storage_path?: string
          thread_id?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "forum_media_reply_id_fkey"
            columns: ["reply_id"]
            isOneToOne: false
            referencedRelation: "forum_replies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forum_media_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "forum_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      forum_notifications: {
        Row: {
          actor_id: string | null
          created_at: string
          data: Json
          id: string
          kind: string
          read_at: string | null
          target_id: string | null
          target_kind: Database["public"]["Enums"]["forum_target_kind"] | null
          user_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          data?: Json
          id?: string
          kind: string
          read_at?: string | null
          target_id?: string | null
          target_kind?: Database["public"]["Enums"]["forum_target_kind"] | null
          user_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          data?: Json
          id?: string
          kind?: string
          read_at?: string | null
          target_id?: string | null
          target_kind?: Database["public"]["Enums"]["forum_target_kind"] | null
          user_id?: string
        }
        Relationships: []
      }
      forum_reactions: {
        Row: {
          created_at: string
          emoji: string
          id: string
          target_id: string
          target_kind: Database["public"]["Enums"]["forum_target_kind"]
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          id?: string
          target_id: string
          target_kind: Database["public"]["Enums"]["forum_target_kind"]
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          id?: string
          target_id?: string
          target_kind?: Database["public"]["Enums"]["forum_target_kind"]
          user_id?: string
        }
        Relationships: []
      }
      forum_replies: {
        Row: {
          author_id: string
          body_md: string
          created_at: string
          hidden_at: string | null
          hidden_reason: string | null
          id: string
          is_solution: boolean
          parent_reply_id: string | null
          posted_as_admin: boolean
          reaction_count: number
          thread_id: string
          updated_at: string
        }
        Insert: {
          author_id: string
          body_md: string
          created_at?: string
          hidden_at?: string | null
          hidden_reason?: string | null
          id?: string
          is_solution?: boolean
          parent_reply_id?: string | null
          posted_as_admin?: boolean
          reaction_count?: number
          thread_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          body_md?: string
          created_at?: string
          hidden_at?: string | null
          hidden_reason?: string | null
          id?: string
          is_solution?: boolean
          parent_reply_id?: string | null
          posted_as_admin?: boolean
          reaction_count?: number
          thread_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "forum_replies_parent_reply_id_fkey"
            columns: ["parent_reply_id"]
            isOneToOne: false
            referencedRelation: "forum_replies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forum_replies_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "forum_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      forum_reports: {
        Row: {
          created_at: string
          details: string | null
          handled_at: string | null
          handled_by: string | null
          id: string
          reason: string
          reporter_id: string
          status: Database["public"]["Enums"]["forum_report_status"]
          target_id: string
          target_kind: Database["public"]["Enums"]["forum_target_kind"]
        }
        Insert: {
          created_at?: string
          details?: string | null
          handled_at?: string | null
          handled_by?: string | null
          id?: string
          reason: string
          reporter_id: string
          status?: Database["public"]["Enums"]["forum_report_status"]
          target_id: string
          target_kind: Database["public"]["Enums"]["forum_target_kind"]
        }
        Update: {
          created_at?: string
          details?: string | null
          handled_at?: string | null
          handled_by?: string | null
          id?: string
          reason?: string
          reporter_id?: string
          status?: Database["public"]["Enums"]["forum_report_status"]
          target_id?: string
          target_kind?: Database["public"]["Enums"]["forum_target_kind"]
        }
        Relationships: []
      }
      forum_subscriptions: {
        Row: {
          created_at: string
          thread_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          thread_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          thread_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forum_subscriptions_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "forum_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      forum_tags: {
        Row: {
          color: string | null
          created_at: string
          id: string
          name: string
          slug: string
          usage_count: number
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          name: string
          slug: string
          usage_count?: number
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          name?: string
          slug?: string
          usage_count?: number
        }
        Relationships: []
      }
      forum_thread_tags: {
        Row: {
          tag_id: string
          thread_id: string
        }
        Insert: {
          tag_id: string
          thread_id: string
        }
        Update: {
          tag_id?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forum_thread_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "forum_tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forum_thread_tags_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "forum_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      forum_thread_views: {
        Row: {
          first_viewed_at: string
          id: string
          last_viewed_at: string
          thread_id: string
          user_id: string
          view_count: number
        }
        Insert: {
          first_viewed_at?: string
          id?: string
          last_viewed_at?: string
          thread_id: string
          user_id: string
          view_count?: number
        }
        Update: {
          first_viewed_at?: string
          id?: string
          last_viewed_at?: string
          thread_id?: string
          user_id?: string
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "forum_thread_views_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "forum_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      forum_threads: {
        Row: {
          author_id: string
          body_md: string
          category_id: string
          created_at: string
          hidden_at: string | null
          hidden_reason: string | null
          id: string
          is_locked: boolean
          is_pinned: boolean
          is_solved: boolean
          last_activity_at: string
          posted_as_admin: boolean
          reaction_count: number
          reply_count: number
          slug: string
          solved_reply_id: string | null
          title: string
          updated_at: string
          views: number
        }
        Insert: {
          author_id: string
          body_md: string
          category_id: string
          created_at?: string
          hidden_at?: string | null
          hidden_reason?: string | null
          id?: string
          is_locked?: boolean
          is_pinned?: boolean
          is_solved?: boolean
          last_activity_at?: string
          posted_as_admin?: boolean
          reaction_count?: number
          reply_count?: number
          slug: string
          solved_reply_id?: string | null
          title: string
          updated_at?: string
          views?: number
        }
        Update: {
          author_id?: string
          body_md?: string
          category_id?: string
          created_at?: string
          hidden_at?: string | null
          hidden_reason?: string | null
          id?: string
          is_locked?: boolean
          is_pinned?: boolean
          is_solved?: boolean
          last_activity_at?: string
          posted_as_admin?: boolean
          reaction_count?: number
          reply_count?: number
          slug?: string
          solved_reply_id?: string | null
          title?: string
          updated_at?: string
          views?: number
        }
        Relationships: [
          {
            foreignKeyName: "forum_threads_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "forum_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forum_threads_solved_reply_fk"
            columns: ["solved_reply_id"]
            isOneToOne: false
            referencedRelation: "forum_replies"
            referencedColumns: ["id"]
          },
        ]
      }
      forum_user_sanctions: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          issued_by: string | null
          lifted_at: string | null
          lifted_by: string | null
          reason: string | null
          type: Database["public"]["Enums"]["forum_sanction_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          issued_by?: string | null
          lifted_at?: string | null
          lifted_by?: string | null
          reason?: string | null
          type: Database["public"]["Enums"]["forum_sanction_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          issued_by?: string | null
          lifted_at?: string | null
          lifted_by?: string | null
          reason?: string | null
          type?: Database["public"]["Enums"]["forum_sanction_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      forum_user_stats: {
        Row: {
          banned_at: string | null
          banned_reason: string | null
          is_banned: boolean
          last_post_at: string | null
          replies_count: number
          reputation: number
          solutions_count: number
          threads_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          banned_at?: string | null
          banned_reason?: string | null
          is_banned?: boolean
          last_post_at?: string | null
          replies_count?: number
          reputation?: number
          solutions_count?: number
          threads_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          banned_at?: string | null
          banned_reason?: string | null
          is_banned?: boolean
          last_post_at?: string | null
          replies_count?: number
          reputation?: number
          solutions_count?: number
          threads_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      free_trial_assignments: {
        Row: {
          api_key_record_id: string
          created_at: string
          device_fingerprint: string | null
          free_trial_key_id: string
          id: string
          ip_hash: string | null
          override_allowed_at: string | null
          session_number: number
          user_id: string
        }
        Insert: {
          api_key_record_id: string
          created_at?: string
          device_fingerprint?: string | null
          free_trial_key_id: string
          id?: string
          ip_hash?: string | null
          override_allowed_at?: string | null
          session_number: number
          user_id: string
        }
        Update: {
          api_key_record_id?: string
          created_at?: string
          device_fingerprint?: string | null
          free_trial_key_id?: string
          id?: string
          ip_hash?: string | null
          override_allowed_at?: string | null
          session_number?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "free_trial_assignments_api_key_record_id_fkey"
            columns: ["api_key_record_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "free_trial_assignments_free_trial_key_id_fkey"
            columns: ["free_trial_key_id"]
            isOneToOne: false
            referencedRelation: "free_trial_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      free_trial_keys: {
        Row: {
          api_key: string
          claimed_at: string | null
          claimed_by_user_id: string | null
          created_at: string
          id: string
          trial_duration_ms: number | null
        }
        Insert: {
          api_key: string
          claimed_at?: string | null
          claimed_by_user_id?: string | null
          created_at?: string
          id?: string
          trial_duration_ms?: number | null
        }
        Update: {
          api_key?: string
          claimed_at?: string | null
          claimed_by_user_id?: string | null
          created_at?: string
          id?: string
          trial_duration_ms?: number | null
        }
        Relationships: []
      }
      operating_expenses: {
        Row: {
          amount_usd: number
          category_id: string
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          occurred_on: string
          updated_at: string
          vendor: string | null
        }
        Insert: {
          amount_usd: number
          category_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          occurred_on?: string
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          amount_usd?: number
          category_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          occurred_on?: string
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "operating_expenses_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "expense_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_attributions: {
        Row: {
          attributed_at: string
          id: string
          partner_id: string
          source: string
          user_id: string
        }
        Insert: {
          attributed_at?: string
          id?: string
          partner_id: string
          source: string
          user_id: string
        }
        Update: {
          attributed_at?: string
          id?: string
          partner_id?: string
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_attributions_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "partners"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_override_earnings: {
        Row: {
          amount_usd: number
          beneficiary_partner_id: string
          commission_base_usd: number
          created_at: string
          depth: number
          id: string
          override_pct: number
          payment_id: string
          source_partner_id: string
          status: string
          updated_at: string
        }
        Insert: {
          amount_usd: number
          beneficiary_partner_id: string
          commission_base_usd: number
          created_at?: string
          depth: number
          id?: string
          override_pct: number
          payment_id: string
          source_partner_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount_usd?: number
          beneficiary_partner_id?: string
          commission_base_usd?: number
          created_at?: string
          depth?: number
          id?: string
          override_pct?: number
          payment_id?: string
          source_partner_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_override_earnings_beneficiary_partner_id_fkey"
            columns: ["beneficiary_partner_id"]
            isOneToOne: false
            referencedRelation: "partners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_override_earnings_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_override_earnings_source_partner_id_fkey"
            columns: ["source_partner_id"]
            isOneToOne: false
            referencedRelation: "partners"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_override_payouts: {
        Row: {
          amount_usd: number
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          paid_at: string
          partner_id: string
        }
        Insert: {
          amount_usd: number
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          paid_at?: string
          partner_id: string
        }
        Update: {
          amount_usd?: number
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          paid_at?: string
          partner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_override_payouts_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "partners"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_payouts: {
        Row: {
          amount_usd: number
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          paid_at: string
          partner_id: string
        }
        Insert: {
          amount_usd: number
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          paid_at?: string
          partner_id: string
        }
        Update: {
          amount_usd?: number
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          paid_at?: string
          partner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_payouts_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "partners"
            referencedColumns: ["id"]
          },
        ]
      }
      partners: {
        Row: {
          code: string
          commission_pct: number
          created_at: string
          display_name: string | null
          id: string
          is_active: boolean
          override_pct: number
          parent_partner_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          code: string
          commission_pct?: number
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          override_pct?: number
          parent_partner_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          code?: string
          commission_pct?: number
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          override_pct?: number
          parent_partner_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "partners_parent_partner_id_fkey"
            columns: ["parent_partner_id"]
            isOneToOne: false
            referencedRelation: "partners"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_nudge_history: {
        Row: {
          headline_snippet: string | null
          id: string
          preset_id: string
          sent_at: string
          sent_by: string | null
          subject: string | null
          user_id: string
        }
        Insert: {
          headline_snippet?: string | null
          id?: string
          preset_id: string
          sent_at?: string
          sent_by?: string | null
          subject?: string | null
          user_id: string
        }
        Update: {
          headline_snippet?: string | null
          id?: string
          preset_id?: string
          sent_at?: string
          sent_by?: string | null
          subject?: string | null
          user_id?: string
        }
        Relationships: []
      }
      payment_verification_attempts: {
        Row: {
          attempted_at: string
          confirmations: number | null
          expected_amount_usd: number | null
          id: string
          on_chain_amount: number | null
          outcome: string
          payment_id: string
          raw: Json | null
          reason: string | null
        }
        Insert: {
          attempted_at?: string
          confirmations?: number | null
          expected_amount_usd?: number | null
          id?: string
          on_chain_amount?: number | null
          outcome: string
          payment_id: string
          raw?: Json | null
          reason?: string | null
        }
        Update: {
          attempted_at?: string
          confirmations?: number | null
          expected_amount_usd?: number | null
          id?: string
          on_chain_amount?: number | null
          outcome?: string
          payment_id?: string
          raw?: Json | null
          reason?: string | null
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount_usd: number | null
          commission_base_usd_snapshot: number | null
          commission_pct_snapshot: number | null
          created_at: string
          currency: string | null
          discount_amount_usd: number | null
          discount_code: string | null
          id: string
          payment_method: string
          pending_key_assignment: boolean
          plan_id: string | null
          status: string
          tx_hash: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount_usd?: number | null
          commission_base_usd_snapshot?: number | null
          commission_pct_snapshot?: number | null
          created_at?: string
          currency?: string | null
          discount_amount_usd?: number | null
          discount_code?: string | null
          id?: string
          payment_method?: string
          pending_key_assignment?: boolean
          plan_id?: string | null
          status?: string
          tx_hash?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount_usd?: number | null
          commission_base_usd_snapshot?: number | null
          commission_pct_snapshot?: number | null
          created_at?: string
          currency?: string | null
          discount_amount_usd?: number | null
          discount_code?: string | null
          id?: string
          payment_method?: string
          pending_key_assignment?: boolean
          plan_id?: string | null
          status?: string
          tx_hash?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "pricing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "pricing_plans_public"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_plans: {
        Row: {
          commission_base_usd: number | null
          created_at: string
          description: string | null
          features: string[] | null
          id: string
          is_active: boolean
          key_duration_minutes: number | null
          low_stock_threshold: number
          name: string
          price_usd: number
          price_usd_annual: number | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          commission_base_usd?: number | null
          created_at?: string
          description?: string | null
          features?: string[] | null
          id?: string
          is_active?: boolean
          key_duration_minutes?: number | null
          low_stock_threshold?: number
          name: string
          price_usd?: number
          price_usd_annual?: number | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          commission_base_usd?: number | null
          created_at?: string
          description?: string | null
          features?: string[] | null
          id?: string
          is_active?: boolean
          key_duration_minutes?: number | null
          low_stock_threshold?: number
          name?: string
          price_usd?: number
          price_usd_annual?: number | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          last_payment_nudge_sent_at: string | null
          last_seen_at: string | null
          payment_funnel_stage: number
          payment_funnel_updated_at: string | null
          preferred_currency: string | null
          preferred_language: string | null
          terms_accepted_at: string | null
          terms_version: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          last_payment_nudge_sent_at?: string | null
          last_seen_at?: string | null
          payment_funnel_stage?: number
          payment_funnel_updated_at?: string | null
          preferred_currency?: string | null
          preferred_language?: string | null
          terms_accepted_at?: string | null
          terms_version?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          last_payment_nudge_sent_at?: string | null
          last_seen_at?: string | null
          payment_funnel_stage?: number
          payment_funnel_updated_at?: string | null
          preferred_currency?: string | null
          preferred_language?: string | null
          terms_accepted_at?: string | null
          terms_version?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      reviews: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          is_approved: boolean
          rating: number
          remark: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          is_approved?: boolean
          rating: number
          remark: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          is_approved?: boolean
          rating?: number
          remark?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      studio_pricing_config: {
        Row: {
          credits_per_second: number
          handshake_floor_ms: number
          hard_stale_ms: number
          heartbeat_grace_ms: number
          id: boolean
          reap_stale_ms: number
          updated_at: string
          warmup_grace_ms: number
        }
        Insert: {
          credits_per_second?: number
          handshake_floor_ms?: number
          hard_stale_ms?: number
          heartbeat_grace_ms?: number
          id?: boolean
          reap_stale_ms?: number
          updated_at?: string
          warmup_grace_ms?: number
        }
        Update: {
          credits_per_second?: number
          handshake_floor_ms?: number
          hard_stale_ms?: number
          heartbeat_grace_ms?: number
          id?: boolean
          reap_stale_ms?: number
          updated_at?: string
          warmup_grace_ms?: number
        }
        Relationships: []
      }
      studio_session_reconciliations: {
        Row: {
          created_at: string
          debited_ms: number
          reason: string
          session_id: string
        }
        Insert: {
          created_at?: string
          debited_ms?: number
          reason: string
          session_id: string
        }
        Update: {
          created_at?: string
          debited_ms?: number
          reason?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "studio_session_reconciliations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "studio_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      studio_sessions: {
        Row: {
          api_key_id: string
          created_at: string
          duration_ms: number | null
          end_reason: string | null
          ended_at: string | null
          first_heartbeat_at: string | null
          id: string
          is_trial: boolean
          key_label: string | null
          last_debit_at: string
          last_heartbeat_at: string
          min_bill_ms: number
          remaining_ms_at_end: number | null
          remaining_ms_at_start: number | null
          session_id: string
          started_at: string
          user_id: string
        }
        Insert: {
          api_key_id: string
          created_at?: string
          duration_ms?: number | null
          end_reason?: string | null
          ended_at?: string | null
          first_heartbeat_at?: string | null
          id?: string
          is_trial?: boolean
          key_label?: string | null
          last_debit_at?: string
          last_heartbeat_at?: string
          min_bill_ms?: number
          remaining_ms_at_end?: number | null
          remaining_ms_at_start?: number | null
          session_id: string
          started_at?: string
          user_id: string
        }
        Update: {
          api_key_id?: string
          created_at?: string
          duration_ms?: number | null
          end_reason?: string | null
          ended_at?: string | null
          first_heartbeat_at?: string | null
          id?: string
          is_trial?: boolean
          key_label?: string | null
          last_debit_at?: string
          last_heartbeat_at?: string
          min_bill_ms?: number
          remaining_ms_at_end?: number | null
          remaining_ms_at_start?: number | null
          session_id?: string
          started_at?: string
          user_id?: string
        }
        Relationships: []
      }
      support_canned_responses: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          id: string
          shortcut: string | null
          title: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          created_by?: string | null
          id?: string
          shortcut?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          shortcut?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      support_conversations: {
        Row: {
          assigned_to: string | null
          created_at: string
          id: string
          priority: string
          status: string
          subject: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          id?: string
          priority?: string
          status?: string
          subject?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          id?: string
          priority?: string
          status?: string
          subject?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      support_internal_notes: {
        Row: {
          author_id: string
          content: string
          conversation_id: string
          created_at: string
          id: string
        }
        Insert: {
          author_id: string
          content: string
          conversation_id: string
          created_at?: string
          id?: string
        }
        Update: {
          author_id?: string
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
        }
        Relationships: []
      }
      support_messages: {
        Row: {
          content: string | null
          conversation_id: string
          created_at: string
          file_name: string | null
          file_size: number | null
          file_type: string | null
          file_url: string | null
          id: string
          is_admin: boolean
          sender_id: string
        }
        Insert: {
          content?: string | null
          conversation_id: string
          created_at?: string
          file_name?: string | null
          file_size?: number | null
          file_type?: string | null
          file_url?: string | null
          id?: string
          is_admin?: boolean
          sender_id: string
        }
        Update: {
          content?: string | null
          conversation_id?: string
          created_at?: string
          file_name?: string | null
          file_size?: number | null
          file_type?: string | null
          file_url?: string | null
          id?: string
          is_admin?: boolean
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "support_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
        }
        Relationships: []
      }
      system_announcements: {
        Row: {
          created_at: string
          created_by: string | null
          cta_label: string | null
          cta_url: string | null
          display_banner: boolean
          display_modal: boolean
          id: string
          is_active: boolean
          message: string
          severity: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          cta_label?: string | null
          cta_url?: string | null
          display_banner?: boolean
          display_modal?: boolean
          id?: string
          is_active?: boolean
          message: string
          severity?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          cta_label?: string | null
          cta_url?: string | null
          display_banner?: boolean
          display_modal?: boolean
          id?: string
          is_active?: boolean
          message?: string
          severity?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      terms_acceptances: {
        Row: {
          accepted_at: string
          email: string | null
          id: string
          ip_hash: string | null
          source: string
          terms_version: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          accepted_at?: string
          email?: string | null
          id?: string
          ip_hash?: string | null
          source: string
          terms_version: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          accepted_at?: string
          email?: string | null
          id?: string
          ip_hash?: string | null
          source?: string
          terms_version?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      translation_cache: {
        Row: {
          created_at: string
          hit_count: number
          id: string
          source_hash: string
          source_lang: string
          source_text: string
          target_lang: string
          translated_text: string
        }
        Insert: {
          created_at?: string
          hit_count?: number
          id?: string
          source_hash: string
          source_lang?: string
          source_text: string
          target_lang: string
          translated_text: string
        }
        Update: {
          created_at?: string
          hit_count?: number
          id?: string
          source_hash?: string
          source_lang?: string
          source_text?: string
          target_lang?: string
          translated_text?: string
        }
        Relationships: []
      }
      trial_purchases: {
        Row: {
          amount_local: number | null
          amount_usd: number
          assigned_key_id: string | null
          confirmed_at: string | null
          created_at: string
          currency: string | null
          id: string
          payment_method: string
          paystack_authorization_url: string | null
          provider_reference: string | null
          status: string
          updated_at: string
          usdt_address: string | null
          usdt_network: string | null
          user_id: string
        }
        Insert: {
          amount_local?: number | null
          amount_usd?: number
          assigned_key_id?: string | null
          confirmed_at?: string | null
          created_at?: string
          currency?: string | null
          id?: string
          payment_method: string
          paystack_authorization_url?: string | null
          provider_reference?: string | null
          status?: string
          updated_at?: string
          usdt_address?: string | null
          usdt_network?: string | null
          user_id: string
        }
        Update: {
          amount_local?: number | null
          amount_usd?: number
          assigned_key_id?: string | null
          confirmed_at?: string | null
          created_at?: string
          currency?: string | null
          id?: string
          payment_method?: string
          paystack_authorization_url?: string | null
          provider_reference?: string | null
          status?: string
          updated_at?: string
          usdt_address?: string | null
          usdt_network?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trial_purchases_assigned_key_id_fkey"
            columns: ["assigned_key_id"]
            isOneToOne: false
            referencedRelation: "free_trial_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      user_activity_logs: {
        Row: {
          action: string
          created_at: string
          id: string
          metadata: Json | null
          page: string | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          metadata?: Json | null
          page?: string | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          page?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      forum_public_stats: {
        Row: {
          last_post_at: string | null
          replies_count: number | null
          reputation: number | null
          solutions_count: number | null
          threads_count: number | null
          user_id: string | null
        }
        Insert: {
          last_post_at?: string | null
          replies_count?: number | null
          reputation?: number | null
          solutions_count?: number | null
          threads_count?: number | null
          user_id?: string | null
        }
        Update: {
          last_post_at?: string | null
          replies_count?: number | null
          reputation?: number | null
          solutions_count?: number | null
          threads_count?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      my_forum_stats: {
        Row: {
          is_banned: boolean | null
          last_post_at: string | null
          replies_count: number | null
          reputation: number | null
          solutions_count: number | null
          threads_count: number | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          is_banned?: boolean | null
          last_post_at?: string | null
          replies_count?: number | null
          reputation?: number | null
          solutions_count?: number | null
          threads_count?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          is_banned?: boolean | null
          last_post_at?: string | null
          replies_count?: number | null
          reputation?: number | null
          solutions_count?: number | null
          threads_count?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      pricing_plans_public: {
        Row: {
          description: string | null
          features: string[] | null
          id: string | null
          is_active: boolean | null
          key_duration_minutes: number | null
          name: string | null
          price_usd: number | null
          price_usd_annual: number | null
          sort_order: number | null
        }
        Insert: {
          description?: string | null
          features?: string[] | null
          id?: string | null
          is_active?: boolean | null
          key_duration_minutes?: number | null
          name?: string | null
          price_usd?: number | null
          price_usd_annual?: number | null
          sort_order?: number | null
        }
        Update: {
          description?: string | null
          features?: string[] | null
          id?: string | null
          is_active?: boolean | null
          key_duration_minutes?: number | null
          name?: string | null
          price_usd?: number | null
          price_usd_annual?: number | null
          sort_order?: number | null
        }
        Relationships: []
      }
      reviews_public: {
        Row: {
          created_at: string | null
          display_name: string | null
          id: string | null
          is_approved: boolean | null
          public_name: string | null
          rating: number | null
          remark: string | null
          updated_at: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      admin_allow_trial_for_device: {
        Args: { p_fingerprint: string }
        Returns: number
      }
      admin_announcement_view_summary: {
        Args: never
        Returns: {
          announcement_id: string
          total_views: number
          unique_viewers: number
        }[]
      }
      admin_create_announcement: {
        Args: {
          p_cta_label: string
          p_cta_url: string
          p_display_banner: boolean
          p_display_modal: boolean
          p_is_active: boolean
          p_message: string
          p_severity: string
          p_title: string
        }
        Returns: {
          created_at: string
          created_by: string | null
          cta_label: string | null
          cta_url: string | null
          display_banner: boolean
          display_modal: boolean
          id: string
          is_active: boolean
          message: string
          severity: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "system_announcements"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_delete_announcement: { Args: { p_id: string }; Returns: boolean }
      admin_list_announcement_viewers: {
        Args: { p_announcement_id: string }
        Returns: {
          display_name: string
          email: string
          first_viewed_at: string
          last_viewed_at: string
          user_id: string
          view_count: number
        }[]
      }
      admin_list_key_activity: {
        Args: { p_days?: number; p_filter?: string }
        Returns: {
          active_session_id: string
          assigned_at: string
          expires_at: string
          first_session_at: string
          is_active: boolean
          is_trial: boolean
          key_id: string
          label: string
          last_activity_at: string
          remaining_ms: number
          sessions_count: number
          status: string
          total_used_ms: number
          user_email: string
          user_id: string
        }[]
      }
      admin_list_thread_viewers: {
        Args: { p_thread_id: string }
        Returns: {
          display_name: string
          email: string
          first_viewed_at: string
          last_viewed_at: string
          user_id: string
          view_count: number
        }[]
      }
      admin_manage_trial_purchase: {
        Args: { p_action: string; p_purchase_id: string }
        Returns: Json
      }
      admin_paid_user_usage: {
        Args: { p_from?: string; p_include_trial?: boolean; p_to?: string }
        Returns: {
          avg_duration_ms: number
          display_name: string
          email: string
          first_payment_at: string
          first_session_at: string
          is_currently_live: boolean
          last_session_at: string
          total_duration_ms: number
          total_sessions: number
          user_id: string
        }[]
      }
      admin_rebuild_override_ledger: {
        Args: { p_source_partner_id?: string }
        Returns: number
      }
      admin_set_announcement_active: {
        Args: { p_id: string; p_is_active: boolean }
        Returns: {
          created_at: string
          created_by: string | null
          cta_label: string | null
          cta_url: string | null
          display_banner: boolean
          display_modal: boolean
          id: string
          is_active: boolean
          message: string
          severity: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "system_announcements"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_set_partner_for_user: {
        Args: { p_partner_id: string; p_user_id: string }
        Returns: undefined
      }
      admin_set_partner_parent: {
        Args: { p_parent_partner_id: string; p_partner_id: string }
        Returns: undefined
      }
      admin_set_payment_status: {
        Args: {
          p_amount_usd?: number
          p_payment_id: string
          p_plan_id?: string
          p_status: string
        }
        Returns: {
          amount_usd: number | null
          commission_base_usd_snapshot: number | null
          commission_pct_snapshot: number | null
          created_at: string
          currency: string | null
          discount_amount_usd: number | null
          discount_code: string | null
          id: string
          payment_method: string
          pending_key_assignment: boolean
          plan_id: string | null
          status: string
          tx_hash: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "payments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_thread_view_summary: {
        Args: never
        Returns: {
          thread_id: string
          total_views: number
          unique_viewers: number
        }[]
      }
      admin_time_ledger: { Args: never; Returns: Json }
      admin_update_announcement: {
        Args: {
          p_cta_label: string
          p_cta_url: string
          p_display_banner: boolean
          p_display_modal: boolean
          p_id: string
          p_is_active: boolean
          p_message: string
          p_severity: string
          p_title: string
        }
        Returns: {
          created_at: string
          created_by: string | null
          cta_label: string | null
          cta_url: string | null
          display_banner: boolean
          display_modal: boolean
          id: string
          is_active: boolean
          message: string
          severity: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "system_announcements"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      app_notify: {
        Args: {
          p_actor_id?: string
          p_body?: string
          p_category: string
          p_data?: Json
          p_href?: string
          p_kind: string
          p_severity?: string
          p_target_id?: string
          p_target_kind?: string
          p_title: string
          p_user_id: string
        }
        Returns: string
      }
      assign_trial_key_from_purchase: {
        Args: { p_purchase_id: string }
        Returns: {
          api_key: string
          api_key_id: string
          duration_ms: number
          expires_at: string
        }[]
      }
      attach_partner_code: {
        Args: { p_code: string; p_source: string }
        Returns: Json
      }
      auto_confirm_payment_from_verifier: {
        Args: {
          p_amount_usd?: number
          p_payment_id: string
          p_plan_id?: string
        }
        Returns: {
          amount_usd: number | null
          commission_base_usd_snapshot: number | null
          commission_pct_snapshot: number | null
          created_at: string
          currency: string | null
          discount_amount_usd: number | null
          discount_code: string | null
          id: string
          payment_method: string
          pending_key_assignment: boolean
          plan_id: string | null
          status: string
          tx_hash: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "payments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      broadcast_cooldown_remaining_seconds: { Args: never; Returns: number }
      can_manage_discounts: { Args: { _user_id: string }; Returns: boolean }
      can_manage_payments: { Args: { _user_id: string }; Returns: boolean }
      check_studio_session: {
        Args: { p_key: string }
        Returns: {
          is_trial: boolean
          label: string
          ok: boolean
          reason: string
          remaining_ms: number
        }[]
      }
      claim_free_trial_key:
        | {
            Args: never
            Returns: {
              api_key: string
              api_key_id: string
              expires_at: string
              session_number: number
            }[]
          }
        | {
            Args: { p_fingerprint?: string; p_ip_hash?: string }
            Returns: {
              api_key: string
              api_key_id: string
              expires_at: string
              session_number: number
            }[]
          }
      close_studio_session: {
        Args: { p_api_key_id: string; p_reason: string }
        Returns: boolean
      }
      create_partner_self: {
        Args: never
        Returns: {
          code: string
          commission_pct: number
          created_at: string
          display_name: string | null
          id: string
          is_active: boolean
          override_pct: number
          parent_partner_id: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "partners"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      deactivate_expired_api_keys: { Args: never; Returns: undefined }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      email_queue_dispatch: { Args: never; Returns: undefined }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      export_auth_identities_for_backup: {
        Args: never
        Returns: {
          created_at: string
          email: string
          id: string
          last_sign_in_at: string
          provider: string
          provider_id: string
          updated_at: string
          user_id: string
        }[]
      }
      export_auth_mfa_factors_for_backup: {
        Args: never
        Returns: {
          created_at: string
          factor_type: string
          friendly_name: string
          id: string
          status: string
          updated_at: string
          user_id: string
        }[]
      }
      export_auth_sessions_for_backup: {
        Args: never
        Returns: {
          created_at: string
          id: string
          ip: unknown
          updated_at: string
          user_agent: string
          user_id: string
        }[]
      }
      export_auth_users_for_backup: {
        Args: never
        Returns: {
          banned_until: string
          created_at: string
          email: string
          email_confirmed_at: string
          id: string
          is_sso_user: boolean
          last_sign_in_at: string
          phone: string
          phone_confirmed_at: string
          raw_app_meta_data: Json
          raw_user_meta_data: Json
          updated_at: string
        }[]
      }
      export_cron_jobs_for_backup: {
        Args: never
        Returns: {
          active: boolean
          command: string
          database: string
          jobid: number
          jobname: string
          schedule: string
          username: string
        }[]
      }
      export_cron_recent_runs_for_backup: {
        Args: never
        Returns: {
          command: string
          database: string
          end_time: string
          job_pid: number
          jobid: number
          return_message: string
          runid: number
          start_time: string
          status: string
          username: string
        }[]
      }
      export_pgmq_queues_for_backup: {
        Args: never
        Returns: {
          created_at: string
          is_partitioned: boolean
          is_unlogged: boolean
          queue_name: string
        }[]
      }
      export_realtime_publication_for_backup: {
        Args: never
        Returns: {
          schemaname: string
          tablename: string
        }[]
      }
      export_schema_ddl_for_backup: { Args: never; Returns: string }
      export_storage_buckets_for_backup: {
        Args: never
        Returns: {
          allowed_mime_types: string[]
          created_at: string
          file_size_limit: number
          id: string
          name: string
          public: boolean
          updated_at: string
        }[]
      }
      finance_monthly_series: {
        Args: { p_from?: string; p_to?: string }
        Returns: {
          commissions_usd: number
          discounts_usd: number
          expenses_usd: number
          month: string
          net_profit_usd: number
          overrides_usd: number
          revenue_usd: number
        }[]
      }
      finance_overview: {
        Args: { p_from?: string; p_to?: string }
        Returns: {
          cash_owed_usd: number
          confirmed_payments_count: number
          discounts_usd: number
          gross_revenue_usd: number
          net_profit_usd: number
          net_revenue_usd: number
          operating_expenses_usd: number
          override_commission_accrued_usd: number
          override_commission_balance_usd: number
          override_commission_paid_usd: number
          partner_commission_accrued_usd: number
          partner_commission_balance_usd: number
          partner_commission_paid_usd: number
        }[]
      }
      finance_partner_rollup: {
        Args: { p_from?: string; p_to?: string }
        Returns: {
          balance_owed_usd: number
          code: string
          commission_pct: number
          confirmed_payments: number
          display_name: string
          downline_count: number
          gross_earnings_usd: number
          is_active: boolean
          override_balance_usd: number
          override_earned_usd: number
          override_paid_usd: number
          paid_out_usd: number
          parent_partner_id: string
          partner_id: string
          referred_users: number
        }[]
      }
      forum_award: {
        Args: { _delta: number; _user_id: string }
        Returns: undefined
      }
      forum_can_view_category: {
        Args: { _category_id: string }
        Returns: boolean
      }
      forum_is_banned: { Args: { _user_id: string }; Returns: boolean }
      forum_mark_solution: { Args: { p_reply_id: string }; Returns: undefined }
      forum_reaction_counts: {
        Args: { _target_id: string; _target_kind: string }
        Returns: {
          count: number
          emoji: string
        }[]
      }
      get_promo_code_status: {
        Args: { p_code: string }
        Returns: {
          percent_off: number
        }[]
      }
      has_role:
        | {
            Args: { _role: Database["public"]["Enums"]["app_role"] }
            Returns: boolean
          }
        | {
            Args: {
              _role: Database["public"]["Enums"]["app_role"]
              _user_id: string
            }
            Returns: boolean
          }
      heartbeat_studio_session: {
        Args: { p_key: string; p_session_id: string }
        Returns: boolean
      }
      is_email_confirmed: { Args: { uid: string }; Returns: boolean }
      is_partner: { Args: { _user_id: string }; Returns: boolean }
      is_sec_admin: { Args: { _user_id: string }; Returns: boolean }
      is_staff:
        | { Args: never; Returns: boolean }
        | { Args: { _user_id: string }; Returns: boolean }
      issue_api_key_for_payment: {
        Args: { p_payment_id: string }
        Returns: string
      }
      list_public_tables_for_backup: {
        Args: never
        Returns: {
          table_name: string
        }[]
      }
      log_admin_action: {
        Args: {
          _action: string
          _after: Json
          _before: Json
          _metadata?: Json
          _target_id: string
          _target_type: string
        }
        Returns: undefined
      }
      log_api_key_pool_reveal: {
        Args: { p_pool_id: string }
        Returns: undefined
      }
      mint_studio_credentials: {
        Args: { p_key: string }
        Returns: {
          decart_key: string
          expires_at: string
          is_trial: boolean
          label: string
          ok: boolean
          reason: string
          remaining_ms: number
          session_id: string
        }[]
      }
      mod_apply_sanction: {
        Args: {
          p_duration_hours?: number
          p_reason?: string
          p_type: Database["public"]["Enums"]["forum_sanction_type"]
          p_user_id: string
        }
        Returns: string
      }
      mod_delete_reply: { Args: { p_reply_id: string }; Returns: undefined }
      mod_delete_thread: { Args: { p_thread_id: string }; Returns: undefined }
      mod_hide_reply: {
        Args: { p_hide: boolean; p_reply_id: string }
        Returns: undefined
      }
      mod_hide_thread: {
        Args: { p_hide: boolean; p_thread_id: string }
        Returns: undefined
      }
      mod_lift_sanction: { Args: { p_sanction_id: string }; Returns: undefined }
      mod_resolve_report: {
        Args: { p_notes?: string; p_report_id: string; p_status: string }
        Returns: undefined
      }
      mod_set_thread_flags: {
        Args: {
          p_is_locked?: boolean
          p_is_pinned?: boolean
          p_thread_id: string
        }
        Returns: undefined
      }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      notify_keys_expiring: { Args: never; Returns: number }
      partner_commission_breakdown: {
        Args: { p_partner_id: string }
        Returns: {
          amount_paid_usd: number
          commission_usd: number
          created_at: string
          email_masked: string
          payment_id: string
          plan_name: string
          plan_price_usd: number
          status: string
          user_id: string
        }[]
      }
      partner_downline_tree: {
        Args: { p_partner_id: string }
        Returns: {
          code: string
          commission_pct: number
          depth: number
          display_name: string
          is_active: boolean
          parent_partner_id: string
          partner_id: string
        }[]
      }
      partner_override_breakdown: {
        Args: { p_partner_id: string }
        Returns: {
          amount_usd: number
          commission_base_usd: number
          created_at: string
          depth: number
          id: string
          override_pct: number
          payment_id: string
          source_label: string
          status: string
        }[]
      }
      partner_override_stats: {
        Args: { p_partner_id: string }
        Returns: {
          downline_count: number
          override_balance_usd: number
          override_earnings_usd: number
          override_paid_out_usd: number
        }[]
      }
      partner_referrals: {
        Args: { p_partner_id: string }
        Returns: {
          attributed_at: string
          confirmed_payments: number
          display_name: string
          email_masked: string
          last_payment_at: string
          last_payment_status: string
          source: string
          total_commission_usd: number
          user_id: string
        }[]
      }
      partner_stats: {
        Args: { p_partner_id: string }
        Returns: {
          balance_owed_usd: number
          commission_pct: number
          confirmed_payments: number
          gross_earnings_usd: number
          paid_out_usd: number
          referred_users: number
        }[]
      }
      pause_studio_session: {
        Args: { p_key: string; p_session_id: string }
        Returns: Json
      }
      payment_commission_base_usd: {
        Args: { p_amount_usd: number; p_plan_id: string }
        Returns: number
      }
      payments_pending_verification: {
        Args: never
        Returns: {
          id: string
        }[]
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      reap_orphaned_studio_sessions: { Args: never; Returns: number }
      reap_stale_provider_credential_locks: {
        Args: {
          p_current_api_key_id: string
          p_decart_key: string
          p_live_window_ms?: number
        }
        Returns: string
      }
      record_announcement_view: {
        Args: { p_announcement_id: string }
        Returns: undefined
      }
      record_discount_redemption: {
        Args: {
          p_code: string
          p_discount_amount_usd: number
          p_payment_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      record_studio_connect_attempt: {
        Args: { p_key: string }
        Returns: string
      }
      record_thread_view: { Args: { p_thread_id: string }; Returns: undefined }
      server_now_ms: { Args: never; Returns: number }
      start_studio_session: {
        Args: { p_key: string }
        Returns: {
          expires_at: string
          is_trial: boolean
          label: string
          ok: boolean
          reason: string
          remaining_ms: number
          session_id: string
        }[]
      }
      studio_credits_for_ms: { Args: { p_ms: number }; Returns: number }
      trial_purchases_remaining: {
        Args: { p_user_id: string }
        Returns: number
      }
      validate_discount_code: {
        Args: { p_code: string; p_plan_id: string }
        Returns: {
          code_id: string
          discount_usd: number
          final_usd: number
          percent_off: number
          reason: string
          valid: boolean
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user" | "partner" | "sec_admin"
      forum_access_level: "public" | "partners" | "admins"
      forum_media_kind: "image" | "audio"
      forum_media_status: "pending" | "approved" | "rejected"
      forum_report_status: "open" | "actioned" | "dismissed"
      forum_sanction_type: "warn" | "mute" | "ban"
      forum_target_kind: "thread" | "reply"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user", "partner", "sec_admin"],
      forum_access_level: ["public", "partners", "admins"],
      forum_media_kind: ["image", "audio"],
      forum_media_status: ["pending", "approved", "rejected"],
      forum_report_status: ["open", "actioned", "dismissed"],
      forum_sanction_type: ["warn", "mute", "ban"],
      forum_target_kind: ["thread", "reply"],
    },
  },
} as const
