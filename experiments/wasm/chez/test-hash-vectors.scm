(define (show label value)
  (display label) (display " ") (display value) (newline))

(show "sha-empty" (bytevector->hex (sha256 (string->utf8 ""))))
(show "sha-abc" (bytevector->hex (sha256 (string->utf8 "abc"))))
(show "sha-long" (bytevector->hex (sha256 (string->utf8 "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))))
(show "canonical-empty" (bytevector->hex (canonical-source-bytes "")))
(show "tree-define" (tree-hash "(define (double x) (* x 2))"))
