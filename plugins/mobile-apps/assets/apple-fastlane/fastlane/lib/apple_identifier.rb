# frozen_string_literal: true

require "json"
require "time"

module MobileAppAppleIdentifier
  VERSION = "1.0.0"
  TEAM_ID = /\A[A-Z0-9]{10}\z/
  BUNDLE_ID = /\A[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+\z/
  PROOF_SECONDS = 60 * 60

  class Blocked < StandardError
    attr_reader :code, :details

    def initialize(code, details = {})
      @code = code
      @details = details
      super(code)
    end
  end

  module_function

  def confirmation_token(team_id, bundle_id)
    "ensure-identifier-capability-#{team_id}-#{bundle_id}"
  end

  def run(team_id:, bundle_id:, app_name:, confirm:, refresh:, adapter:, output_path:, now: Time.now.utc)
    raise Blocked, "invalid-team-id" unless TEAM_ID.match?(team_id.to_s)
    raise Blocked, "invalid-bundle-id" unless BUNDLE_ID.match?(bundle_id.to_s)
    raise Blocked, "invalid-app-name" if app_name.to_s.strip.empty?

    before = adapter.inspect_state(team_id: team_id, bundle_id: bundle_id)
    validate_access!(before)
    validate_conflicts!(before)

    identifier = before[:selected_exact]
    created = false
    push_was_enabled = identifier && identifier[:push_enabled] == true
    mutations = []
    mutations << "create-explicit-identifier" unless identifier
    mutations << "enable-push-notifications" unless push_was_enabled

    unless mutations.empty?
      expected = confirmation_token(team_id, bundle_id)
      unless confirm.to_s == expected
        raise Blocked.new(
          "mutation-confirmation-required",
          mutations: mutations,
          confirmation_token: expected
        )
      end

      unless identifier
        # Creation is Developer-Portal-only: the adapter uses the Portal App ID
        # endpoint directly and never invokes produce's App Store Connect branch.
        adapter.create_explicit_identifier(
          team_id: team_id,
          bundle_id: bundle_id,
          app_name: app_name.to_s.strip
        )
        created = true
      end
      adapter.enable_push(team_id: team_id, bundle_id: bundle_id) unless push_was_enabled
    end

    # A fresh list/details read is mandatory after every no-op or mutation. The
    # write response alone is not proof that Apple stored the intended state.
    after = adapter.inspect_state(team_id: team_id, bundle_id: bundle_id)
    validate_access!(after)
    validate_conflicts!(after)
    verified = after[:selected_exact]
    raise Blocked, "identifier-readback-failed" unless verified
    raise Blocked, "identifier-not-explicit" unless verified[:explicit] == true
    raise Blocked, "identifier-platform-mismatch" unless verified[:platform] == "ios"
    raise Blocked, "identifier-team-mismatch" unless verified[:team_id] == team_id
    raise Blocked, "push-readback-failed" unless verified[:push_enabled] == true

    verified_at = now.utc
    result = {
      "version" => 1,
      "status" => "ready",
      "mode" => "developer-portal-only",
      "teamId" => team_id,
      "bundleId" => bundle_id,
      "identifier" => {
        "resourceId" => verified[:resource_id].to_s,
        "platform" => "ios",
        "type" => "explicit",
        "action" => created ? "created" : "reused",
        "proof" => "exact-identifier-readback"
      },
      "pushCapability" => {
        "capability" => "aps-environment",
        "enabled" => true,
        "action" => push_was_enabled ? "reused" : "enabled",
        "proof" => "app-id-capability-readback"
      },
      "appStoreConnect" => {
        "appCreated" => false,
        "listingCreated" => false
      },
      "proof" => {
        "verifier" => "apple-fastlane-identifier-capability",
        "verifierVersion" => VERSION,
        "verifiedAt" => verified_at.iso8601(3),
        "validUntil" => (verified_at + PROOF_SECONDS).iso8601(3),
        "teamVerified" => true,
        "platformVerified" => true,
        "identifierVerified" => true,
        "pushCapabilityVerified" => true
      }
    }

    write_handoff(output_path, result, refresh: refresh.to_s == "true")
    result
  end

  def validate_access!(state)
    raise Blocked, "team-membership" unless state[:team_found] == true
    raise Blocked, "agreements" if state[:pending_agreements] == true
    raise Blocked, "cip-permissions" unless state[:identifiers_readable] == true
  end

  def validate_conflicts!(state)
    raise Blocked, "wrong-team-conflict" unless Array(state[:other_team_exact]).empty?
    raise Blocked, "wildcard-conflict" unless Array(state[:wildcard_conflicts]).empty?
    raise Blocked, "identifier-conflict" unless Array(state[:case_conflicts]).empty?
    exact = state[:selected_exact]
    return unless exact

    raise Blocked, "identifier-not-explicit" unless exact[:explicit] == true
    raise Blocked, "identifier-platform-mismatch" unless exact[:platform] == "ios"
  end

  def write_handoff(output_path, result, refresh:)
    if File.exist?(output_path) || File.symlink?(output_path)
      raise Blocked, "unsafe-handoff-path" if File.symlink?(output_path) || !File.file?(output_path)
      raise Blocked, "refresh-approval-required" unless refresh
    end

    flags = File::WRONLY | File::CREAT
    flags |= refresh ? File::TRUNC : File::EXCL
    descriptor = File.open(output_path, flags, 0o600)
    begin
      descriptor.write(JSON.pretty_generate(result))
      descriptor.write("\n")
      descriptor.flush
      descriptor.fsync
    ensure
      descriptor.close
    end
  end
end
