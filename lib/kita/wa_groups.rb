# Kita: the desk's side of kita-wa-groups (WhatsApp groups mirrored through a dedicated linked-device number).
# Server to server with X-Kita-Bridge-Secret (BRIDGE_LINK_SECRET); the browser only ever gets a signed,
# short-lived pair link, signed exactly like kita-wa-groups/src/crypto.ts (pairSignature):
#   <WA_GROUPS_PUBLIC_URL>/pair?x=<expiry>&s=HEX(HMAC_SHA256(secret, "wa-groups-pair|<expiry>"))
module Kita::WaGroups
  PAIR_LINK_TTL = 15.minutes
  STATUS_TIMEOUT = 5
  # Joining waits for WhatsApp (invite info + accept)
  JOIN_TIMEOUT = 30

  module_function

  def public_url
    ENV.fetch('WA_GROUPS_PUBLIC_URL', 'https://support.internal.kita.ai/wa-groups').chomp('/')
  end

  def internal_url
    ENV.fetch('WA_GROUPS_INTERNAL_URL', 'http://wa-groups:8090').chomp('/')
  end

  def pair_url(now: Time.current)
    exp = (now + PAIR_LINK_TTL).to_i.to_s
    "#{public_url}/pair?#{URI.encode_www_form(x: exp, s: OpenSSL::HMAC.hexdigest('SHA256', ::Kita::Bridge.secret, "wa-groups-pair|#{exp}"))}"
  end

  # { status, connected, number, send_enabled, groups: [{ jid, subject, participants, joinedAt }] }
  def status
    request(:get, '/wa-groups/status', timeout: STATUS_TIMEOUT)
  end

  # { jid, subject, already? }
  def join(invite_link)
    request(:post, '/wa-groups/join', body: { invite_link: invite_link }.to_json, timeout: JOIN_TIMEOUT)
  end

  def request(method, path, timeout:, **)
    headers = { 'Content-Type' => 'application/json', 'X-Kita-Bridge-Secret' => ::Kita::Bridge.secret }
    response = HTTParty.public_send(method, "#{internal_url}#{path}", **, timeout: timeout, headers: headers)
    body = response.parsed_response
    raise Error.new(response.code, body.is_a?(Hash) ? body['error'] : nil) unless response.success?

    body
  rescue SocketError, Errno::ECONNREFUSED, Net::OpenTimeout, Net::ReadTimeout => e
    raise Error.new(502, e.message)
  end

  # A failed kita-wa-groups call; `status` is the service's HTTP status (422 bad link, 404 revoked, 429 rate limited).
  class Error < StandardError
    attr_reader :status

    def initialize(status, message)
      @status = status
      super(message || "wa-groups #{status}")
    end
  end
end
