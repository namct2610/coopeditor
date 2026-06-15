:80 {
	header {
		Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate"
		Pragma "no-cache"
		Expires "0"
	}

	handle /api/* {
		uri strip_prefix /api
		reverse_proxy api:4000 {
			header_up X-Forwarded-For {remote_host}
			flush_interval -1
		}
	}

	handle /hls/* {
		reverse_proxy api:4000 {
			header_up X-Forwarded-For {remote_host}
			flush_interval -1
		}
	}

	handle /shared/* {
		reverse_proxy api:4000 {
			header_up X-Forwarded-For {remote_host}
			flush_interval -1
		}
	}

	handle {
		reverse_proxy web:3000
	}
}
