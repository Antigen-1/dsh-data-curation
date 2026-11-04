;; Pure Scheme pin rules: no FFI or host capabilities required.
;; JS usage:
;;   const source = await readFile('templates/scheme-decision.scm', 'utf8')
;;   const { pinRules } = await loadSchemeRules(source)
;;   // use pinRules as the project's pin.rules value

(define (two-votes? input)
  (>= (length (object-get input "votes")) 2))

(define (first-vote input)
  (let ((vote (car (object-get input "votes"))))
    (object
      "value" (object-get vote "raw")
      "adopted" (list (object-get vote "channel"))
      "reason" "scheme.two-channel")))

(define object-signature
  (object "args" (list "object") "result" "object"))

(register-rule!
  "scheme.accept-first-after-two"
  "1"
  (decision-with two-votes? first-vote)
  (object
    "role" "decision"
    "description" "两个有效通道后采用第一票"
    "signature" object-signature))

(register-rule!
  "scheme.audit"
  "1"
  (lambda (input)
    (object "checks" (list (object
      "name" "scheme_audit"
      "status" "pass"
      "detail" "Scheme verify rule executed"))))
  (object
    "role" "verify"
    "description" "追加 Scheme 审计检查"
    "signature" object-signature))
