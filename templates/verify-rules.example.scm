;; Verify adapter: append structured checks; the host retains native FAIL gates.
(register-rule!
  "scheme.example.verify"
  "1"
  (lambda (input)
    (object "checks" (list (object
      "name" "scheme_example_audit"
      "status" "pass"
      "detail" "Scheme verify example executed"))))
  (object
    "role" "verify"
    "description" "追加 Scheme 审计检查"
    "signature" (object "args" (list "object") "result" "object")))
