;; Decision adapter: preserve the host's accepted/value/adopted protocol.
(define (two-votes? input)
  (>= (length (object-get input "votes")) 2))

(define (first-vote input)
  (let ((vote (car (object-get input "votes"))))
    (object
      "value" (object-get vote "raw")
      "adopted" (list (object-get vote "channel"))
      "reason" "scheme.example.two-channel")))

(register-rule!
  "scheme.example.decision"
  "1"
  (decision-with two-votes? first-vote)
  (object
    "role" "decision"
    "description" "两个有效通道后采用第一票"
    "signature" (object "args" (list "object") "result" "object")))
