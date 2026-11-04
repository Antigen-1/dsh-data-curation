; dsh-data-curation Scheme flat-contract library.
; This file is lowered by the same restricted frontend as user rules.

(define (%strict-boolean value)
  (if (boolean? value)
      value
      (error "合同谓词必须返回严格 boolean")))

(define (%call-predicate predicate value)
  (%strict-boolean (predicate value)))

(define (not value)
  (if value #f #t))

(define (= a b)
  (and (<= a b) (<= b a)))

; Lowered before Scheme null? is defined, so this captures the core JSON null predicate.
(define (json-null? value)
  (null? value))

(define (null? value)
  (if (list? value) (empty? value) #f))

; Lowered before Scheme string->number is defined, so this captures the core primitive.
(define (string->number value)
  (let ((parsed (string->number value)))
    (if (json-null? parsed) #f parsed)))

(define (conjoin2 left right)
  (lambda (value)
    (and (%call-predicate left value)
         (%call-predicate right value))))

(define (disjoin2 left right)
  (lambda (value)
    (or (%call-predicate left value)
        (%call-predicate right value))))

(define any/c (lambda (value) #t))
(define none/c (lambda (value) #f))

(define (not/c predicate)
  (lambda (value)
    (not (%call-predicate predicate value))))

(define (equal/c expected)
  (lambda (value)
    (equal? value expected)))

(define (list-of/c predicate)
  (lambda (values)
    (if (list? values)
        (let loop ((rest values))
          (if (empty? rest)
              #t
              (if (%call-predicate predicate (car rest))
                  (loop (cdr rest))
                  #f)))
        #f)))

(define (field/c key predicate)
  (lambda (value)
    (if (object? value)
        (if (object-has? value key)
            (%call-predicate predicate (object-get value key))
            #f)
        #f)))

(define (validate-with predicate message)
  (lambda (value)
    (if (%call-predicate predicate value)
        (object "ok" #t "errors" '())
        (object "ok" #f "errors" (list message)))))

(define (decision-with accept? selector)
  (lambda (input)
    (if (%call-predicate accept? input)
        (object-set (selector input) "accepted" #t)
        (object "accepted" #f "reason" "rule_pending"))))
