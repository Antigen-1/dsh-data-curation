;; Example pin.rules source accepted by curation_pin's rulesSource argument.
;; The host compiles it through loadSchemeRules and stores the resulting JSON AST.
;; This is the v1 pin-rule DSL, not a dsh-pin/v2 runtime program.

(define (two-votes? input)
  (>= (length (object-get input "votes")) 2))

(define (first-vote input)
  (let ((vote (car (object-get input "votes"))))
    (object
      "value" (object-get vote "raw")
      "adopted" (list (object-get vote "channel"))
      "reason" "scheme.two-channel")))

(register-rule!
  "scheme.accept-first-after-two"
  "1"
  (decision-with two-votes? first-vote)
  (object
    "role" "decision"
    "description" "两个有效通道后采用第一票"))

(register-rule!
  "scheme.audit"
  "1"
  (lambda (input)
    (object "checks" (list (object
      "name" "scheme_audit"
      "status" "pass"
      "detail" "Scheme verify rule executed"))))
  (object "role" "verify" "description" "追加 Scheme 审计检查"))
