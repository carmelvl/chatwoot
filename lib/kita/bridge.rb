# Kita: the desk's side of kita-bridges (the Slack / Teams / Viber / WhatsApp bridge).
# Connect links are signed exactly like kita-bridges/src/links.ts (signConnectLink):
#   <BRIDGE_PUBLIC_URL>/connect?a=<user id>&e=<email>&x=<expiry>&s=HEX(HMAC_SHA256(secret, "id|email|expiry"))
module Kita::Bridge
  LINK_TTL = 7.days
  EXTERNAL_SOURCES = %w[slack teams whatsapp viber].freeze
  STATUS_TIMEOUT = 5
  # Linking waits for Grip and the scope refresh + merge
  LINK_TIMEOUT = 30

  module_function

  def secret
    ENV.fetch('BRIDGE_LINK_SECRET')
  end

  def public_url
    ENV.fetch('BRIDGE_PUBLIC_URL', 'https://support.internal.kita.ai/bridges').chomp('/')
  end

  # Server-to-server base URL (inside docker compose the bridge is `bridges:8080`).
  def internal_url
    ENV.fetch('BRIDGE_INTERNAL_URL', 'http://bridges:8080').chomp('/')
  end

  def connect_url(user, now: Time.current)
    "#{public_url}/connect?#{URI.encode_www_form(signed_params(user, now: now))}"
  end

  def signed_params(user, now: Time.current)
    email = user.email.downcase
    exp = now.to_i + LINK_TTL.to_i
    { a: user.id.to_s, e: email, x: exp.to_s, s: OpenSSL::HMAC.hexdigest('SHA256', secret, "#{user.id}|#{email}|#{exp}") }
  end

  # Per-platform connection status for one agent (bridge GET /connect/status); raises on failure.
  def status(user)
    response = HTTParty.get("#{internal_url}/connect/status", query: { a: user.id, e: user.email.downcase },
                                                              headers: { 'X-Kita-Bridge-Secret' => secret }, timeout: STATUS_TIMEOUT)
    raise "bridge status #{response.code}" unless response.success?

    response.parsed_response
  end

  # Grip accounts matching `search`, for "Link to customer" (the bridge holds the grip_ key); raises on failure.
  def grip_accounts(search)
    internal_request(:get, '/internal/grip/accounts', query: { search: search })['accounts']
  end

  # Links an unlinked channel to a Grip account and merges its conversation under the customer now.
  def link_channel(channel_key, account_id)
    internal_request(:post, '/internal/grip/link', body: { channel_key: channel_key, account_id: account_id }.to_json)
  end

  def internal_request(method, path, **options)
    response = HTTParty.public_send(method, "#{internal_url}#{path}", **options, timeout: LINK_TIMEOUT,
                                                                                  headers: { 'Content-Type' => 'application/json',
                                                                                             'X-Kita-Bridge-Secret' => secret })
    raise LinkError.new(response.code, response.parsed_response.is_a?(Hash) ? response.parsed_response['error'] : nil) unless response.success?

    response.parsed_response
  end

  # A failed bridge/Grip call: 404 = the channel isn't in Grip's unlinked list.
  class LinkError < StandardError
    attr_reader :status

    def initialize(status, message)
      @status = status
      super(message || "bridge #{status}")
    end
  end

  # Bridge-supplied message metadata: the platform it came through, the desk message it replies to
  # (thread root, rendered with Chatwoot's native reply UI), the platform thread it belongs to and the
  # platform channel it was posted in (human label + channel key).
  def message_attributes(raw)
    return {} unless raw.respond_to?(:permit)

    attrs = raw.permit(:external_source, :external_channel, :external_channel_key, :in_reply_to, external_thread: [:root]).to_h
    attrs.delete(:external_source) unless EXTERNAL_SOURCES.include?(attrs[:external_source])
    attrs[:in_reply_to] = attrs[:in_reply_to].to_i if attrs[:in_reply_to].present?
    attrs.compact_blank
  end

  # Kita's old email domain maps to the current one (EMAIL_DOMAIN_ALIASES="usekita.com=kita.ai,..."),
  # so a Slack/Teams account on suraaj@usekita.com matches the desk agent suraaj@kita.ai.
  def normalize_email(email)
    local, domain = email.to_s.strip.downcase.split('@', 2)
    return local.to_s if domain.nil?

    "#{local}@#{domain_aliases.fetch(domain, domain)}"
  end

  def domain_aliases
    ENV.fetch('EMAIL_DOMAIN_ALIASES', 'usekita.com=kita.ai').split(',').to_h { |pair| pair.strip.downcase.split('=', 2) }
  end

  def valid_secret?(given)
    given.present? && ActiveSupport::SecurityUtils.secure_compare(given, secret)
  end
end
