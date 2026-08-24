# frozen_string_literal: true

require "fileutils"
require "json"
require "tmpdir"
require "time"

module MobileAppAppleCertificates
  VERSION = "1.0.0"
  TEAM_ID = /\A[A-Z0-9]{10}\z/
  RENEWAL_WINDOW_SECONDS = 30 * 24 * 60 * 60
  PROOF_SECONDS = 60 * 60
  TYPES = %w[apple-development apple-distribution].freeze

  class Blocked < StandardError
    attr_reader :code, :details

    def initialize(code, details = {})
      @code = code
      @details = details
      super(code)
    end
  end

  class QuotaExhausted < StandardError; end
  class ImportFailed < StandardError; end

  module_function

  def confirmation_token(team_id)
    "ensure-signing-certificates-#{team_id}"
  end

  def with_private_staging(root: Dir.tmpdir)
    root = File.realpath(root)
    current = root
    loop do
      raise Blocked, "staging-inside-repository" if File.exist?(File.join(current, ".git"))
      parent = File.dirname(current)
      break if parent == current

      current = parent
    end
    directory = Dir.mktmpdir("mobile-app-apple-certificates-", root)
    File.chmod(0o700, directory)
    yield directory
  ensure
    # Certificate and private-key files are transient transport artifacts. The
    # dedicated keychain is the only retained signing-material store.
    FileUtils.rm_rf(directory) if directory && File.basename(directory).start_with?("mobile-app-apple-certificates-")
  end

  def run(team_id:, confirm:, refresh:, adapter:, output_path:, now: Time.now.utc)
    raise Blocked, "invalid-team-id" unless TEAM_ID.match?(team_id.to_s)

    before = adapter.inspect_state(team_id: team_id)
    validate_access!(before)
    selected = select_identities(before.fetch(:certificates, []), now)
    mutations = TYPES.filter_map do |type|
      certificate = selected[type]
      next if reusable?(certificate, now)

      certificate && certificate[:usable] ? "renew-#{type}" : "create-#{type}"
    end

    unless mutations.empty?
      expected = confirmation_token(team_id)
      unless confirm.to_s == expected
        raise Blocked.new(
          "mutation-confirmation-required",
          mutations: mutations,
          confirmation_token: expected,
          renewal_window_days: RENEWAL_WINDOW_SECONDS / 86_400
        )
      end

      mutations.each do |mutation|
        renew = mutation.start_with?("renew-")
        type = mutation.delete_prefix("renew-").delete_prefix("create-")
        begin
          adapter.create_certificate(team_id: team_id, type: type, renew: renew)
        rescue QuotaExhausted
          # Never revoke or force-create to work around Apple's active-certificate
          # quota. An Apple administrator must decide which retained asset to retire.
          raise Blocked, "certificate-quota-admin-decision-required"
        rescue ImportFailed
          raise Blocked, "dedicated-keychain-import-failed"
        end
      end
    end

    after = adapter.inspect_state(team_id: team_id)
    validate_access!(after)
    verified = select_identities(after.fetch(:certificates, []), now)
    TYPES.each do |type|
      certificate = verified[type]
      raise Blocked, "certificate-readback-failed" unless reusable?(certificate, now)
      raise Blocked, "dedicated-keychain-proof-failed" unless certificate[:usable] == true
    end

    verified_at = now.utc
    result = {
      "version" => 1,
      "status" => "ready",
      "teamId" => team_id,
      "renewalWindowDays" => RENEWAL_WINDOW_SECONDS / 86_400,
      "certificates" => TYPES.map do |type|
        certificate = verified.fetch(type)
        {
          "resourceId" => certificate.fetch(:resource_id).to_s,
          "type" => type,
          "expiresAt" => certificate.fetch(:expires_at).utc.iso8601(3),
          "action" => mutations.any? { |entry| entry.end_with?(type) } ? "created" : "reused",
          "proof" => "dedicated-keychain-code-signing-identity"
        }
      end,
      "proof" => {
        "verifier" => "apple-fastlane-signing-certificates",
        "verifierVersion" => VERSION,
        "verifiedAt" => verified_at.iso8601(3),
        "validUntil" => (verified_at + PROOF_SECONDS).iso8601(3),
        "teamVerified" => true,
        "privateKeysUsable" => true
      }
    }
    write_handoff(output_path, result, refresh: refresh.to_s == "true")
    result
  end

  def select_identities(certificates, now)
    TYPES.to_h do |type|
      candidates = certificates.select { |certificate| certificate[:type] == type }
      usable = candidates.select { |certificate| certificate[:usable] == true && certificate[:expires_at] > now }
      [type, usable.max_by { |certificate| certificate[:expires_at] }]
    end
  end

  def reusable?(certificate, now)
    certificate &&
      certificate[:usable] == true &&
      certificate[:expires_at] > now + RENEWAL_WINDOW_SECONDS
  end

  def validate_access!(state)
    raise Blocked, "team-membership" unless state[:team_found] == true
    raise Blocked, "agreements" if state[:pending_agreements] == true
    raise Blocked, "cip-permissions" unless state[:certificates_readable] == true
  end

  def write_handoff(output_path, result, refresh:)
    if File.exist?(output_path) || File.symlink?(output_path)
      raise Blocked, "unsafe-handoff-path" if File.symlink?(output_path) || !File.file?(output_path)
      raise Blocked, "refresh-approval-required" unless refresh
    end

    flags = File::WRONLY | File::CREAT
    flags |= refresh ? File::TRUNC : File::EXCL
    File.open(output_path, flags, 0o600) do |descriptor|
      descriptor.write(JSON.pretty_generate(result))
      descriptor.write("\n")
      descriptor.flush
      descriptor.fsync
    end
  end
end
