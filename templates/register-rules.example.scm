;; Scripted registration: every iteration captures its own value of i.
(define (rule-id i)
  (string-append "scheme.generated." (number->string i)))

(let loop ((i 0))
  (if (= i 3)
      '()
      (begin
        (register-rule!
          (rule-id i)
          "1"
          (lambda (value) (= value i))
          (object "description" "named let generated predicate"))
        (loop (+ i 1)))))
