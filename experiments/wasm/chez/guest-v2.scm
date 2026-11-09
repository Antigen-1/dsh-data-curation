;; Chez Scheme guest v2: read -> datum validation -> eval -> JSON response.
;; The host passes a request as a Scheme datum; this file never parses JSON.
(import (chezscheme))

;; ---------------------------------------------------------------------------
;; JSON value model

(define (dsh-null) (vector 'dsh-null))
(define (dsh-null? v)
  (and (vector? v) (= (vector-length v) 1) (eq? (vector-ref v 0) 'dsh-null)))
(define (dsh-object? v)
  (and (pair? v) (eq? (car v) 'dsh-object)))
(define (dsh-object) (cons 'dsh-object '()))

(define (object . args)
  (let loop ((rest args) (out '()))
    (cond
      ((null? rest) (cons 'dsh-object (reverse out)))
      ((null? (cdr rest))
       (raise (vector 'rule-error "SCHEME_SYNTAX" "object requires key/value pairs")))
      (else
       (loop (cddr rest) (cons (cons (car rest) (cadr rest)) out))))))

(define (object? v) (dsh-object? v))
(define (object-has? obj key)
  (and (dsh-object? obj) (assoc key (cdr obj))))
(define (object-get obj key . fallback)
  (let ((cell (and (dsh-object? obj) (assoc key (cdr obj)))))
    (cond
      (cell (cdr cell))
      ((pair? fallback) (car fallback))
      (else (raise (vector 'rule-error "PRIMITIVE_ERROR" "missing object field"))))))
(define (object-set obj key value)
  (let ((cell (and (dsh-object? obj) (assoc key (cdr obj)))))
    (if cell
        (set-cdr! cell value)
        (set-cdr! obj (cons (cons key value) (cdr obj)))))
  obj)

(define (json-escape s)
  (let ((out (open-output-string)))
    (for-each
      (lambda (c)
        (cond
          ((char=? c #\") (display "\\\"" out))
          ((char=? c #\\) (display "\\\\" out))
          ((char=? c #\newline) (display "\\n" out))
          ((char=? c #\return) (display "\\r" out))
          ((char=? c #\tab) (display "\\t" out))
          (else (write-char c out))))
      (string->list s))
    (get-output-string out)))

(define (join-json xs sep)
  (cond
    ((null? xs) "")
    ((null? (cdr xs)) (car xs))
    (else (string-append (car xs) sep (join-json (cdr xs) sep)))))

(define (json-array xs) (string-append "[" (join-json (map json-value xs) ",") "]"))
(define (json-object xs)
  (string-append "{"
    (join-json
      (map (lambda (x)
             (string-append (json-value (car x)) ":" (json-value (cdr x))))
           xs)
      ",")
    "}"))

(define (json-value v)
  (cond
    ((dsh-null? v) "null")
    ((eq? v #t) "true")
    ((eq? v #f) "false")
    ((number? v) (number->string v))
    ((string? v) (string-append "\"" (json-escape v) "\""))
    ((char? v) (string-append "\"" (json-escape (string v)) "\""))
    ((dsh-object? v) (json-object (cdr v)))
    ((null? v) "[]")
    ((pair? v) (json-array v))
    ((vector? v) (json-array (vector->list v)))
    ((bytevector? v) (json-array (bytevector->u8-list v)))
    ((symbol? v) (string-append "\"" (json-escape (symbol->string v)) "\""))
    (else "null")))

(define (json-ok id value)
  (string-append "{\"id\":" (json-value id) ",\"ok\":true,\"value\":" (json-value value) "}"))
(define (json-error id code message)
  (string-append "{\"id\":" (json-value id) ",\"ok\":false,\"error\":{\"code\":\""
                 (json-escape code) "\",\"message\":\"" (json-escape message) "\"}}"))

(define (json-error-path id code message path)
  (string-append "{\"id\":" (json-value id) ",\"ok\":false,\"error\":{\"code\":\""
                 (json-escape code) "\",\"message\":\"" (json-escape message)
                 "\",\"path\":\"" (json-escape path) "\"}}"))

;; ---------------------------------------------------------------------------
;; Rule runtime and combinators

(define registry '())

(define (substring? s sub)
  (let ((n (string-length s)) (m (string-length sub)))
    (let loop ((i 0))
      (and (<= (+ i m) n)
           (or (string=? (substring s i (+ i m)) sub)
               (loop (+ i 1)))))))

(define (raise-rule-error code message)
  (raise (vector 'rule-error code message)))

(define (condition-code e)
  (if (and (vector? e) (eq? (vector-ref e 0) 'rule-error))
      (vector-ref e 1)
      (let ((msg (error-message e)))
        (cond
          ((substring? msg "not bound") "UNBOUND_VARIABLE")
          ((substring? msg "unbound") "UNBOUND_VARIABLE")
          ((substring? msg "not a procedure") "PRIMITIVE_ERROR")
          ((substring? msg "contract") "PRIMITIVE_ERROR")
          (else "EVAL_ERROR")))))

(define (error-message e)
  (if (and (vector? e) (eq? (vector-ref e 0) 'rule-error))
      (vector-ref e 2)
      (if (condition? e)
          (condition-message e)
          (format "~a" e))))

(define (strict-boolean v)
  (if (boolean? v) v (raise-rule-error "PRIMITIVE_ERROR" "contract predicate must return strict boolean")))

(define-syntax conjoin
  (syntax-rules ()
    ((_) (lambda (x) #t))
    ((_ p q ...) (lambda (x) (and (strict-boolean (p x)) ((conjoin q ...) x))))))

(define-syntax disjoin
  (syntax-rules ()
    ((_) (lambda (x) #f))
    ((_ p q ...) (lambda (x) (or (strict-boolean (p x)) ((disjoin q ...) x))))))

(define-syntax object/c
  (syntax-rules ()
    ((_) (lambda (x) (object? x)))
    ((_ (key pred) rest ...)
     (lambda (x)
       (and (object? x)
            (object-has? x key)
            (strict-boolean (pred (object-get x key)))
            ((object/c rest ...) x))))))

(define-syntax decision-with
  (syntax-rules ()
    ((_ accept selector)
     (lambda (input)
       (if (strict-boolean (accept input))
           (let ((base (selector input)))
             (object-set (object-set base "accepted" #t) "accepted" #t))
           (object "accepted" #f "reason" "rule_pending"))))))

(define (rule-role options)
  (and (pair? options)
       (object? (car options))
       (object-has? (car options) "role")
       (object-get (car options) "role")))

(define (lookup-rule id)
  (let ((cell (assoc id registry)))
    (and cell (cadr cell))))

(define (register-rule! id version proc . options)
  (when (lookup-rule id)
    (raise-rule-error "DUPLICATE_RULE" (string-append "duplicate rule: " id)))
  (let ((role (rule-role options)))
    (when (and role (find (lambda (entry) (equal? (caddr entry) role)) registry))
      (raise-rule-error "DUPLICATE_RULE_ROLE" (string-append "duplicate role: " role)))
    (set! registry (cons (list id proc role) registry))
    id))

(define (sorted-ids)
  (sort string<? (map car registry)))

;; ---------------------------------------------------------------------------
;; Reader and validator

(define (read-all source)
  (let ((port (open-input-string source)))
    (let loop ((forms '()))
      (let ((form (read port)))
        (if (eof-object? form)
            (reverse forms)
            (loop (cons form forms)))))))

(define (has-else? clauses)
  (and (pair? clauses)
       (or (and (pair? (car clauses)) (eq? (caar clauses) 'else))
           (has-else? (cdr clauses)))))

(define (top-level-name form)
  (and (pair? form)
       (eq? (car form) 'define)
       (pair? (cdr form))
       (let ((target (cadr form)))
         (if (pair? target) (car target) target))))

(define top-level-names '())

(define (scan-mutations form)
  (cond
    ((pair? form)
     (when (and (eq? (car form) 'quote)) (void))
     (when (and (eq? (car form) 'set!)
                (pair? (cdr form))
                (memq (cadr form) top-level-names))
       (raise-rule-error "SCHEME_CAPTURE_MUTATION"
                         (string-append "top-level mutation captured: " (symbol->string (cadr form)))))
     (unless (eq? (car form) 'quote)
       (for-each scan-mutations (cdr form))))
    ((vector? form) (for-each scan-mutations (vector->list form)))))

(define (validate-datums! forms)
  (define (walk form)
    (cond
      ((pair? form)
       (when (and (eq? (car form) 'cond)
                  (not (has-else? (cdr form))))
         (raise-rule-error "SCHEME_SYNTAX" "cond requires else clause"))
       (when (and (eq? (car form) 'quote)
                  (= (length form) 2)
                  (symbol? (cadr form)))
         (raise-rule-error "SCHEME_QUOTE" "quoted symbol cannot be a rule result"))
       (unless (eq? (car form) 'quote)
         (for-each walk (cdr form))))
      ((vector? form) (for-each walk (vector->list form)))))
  (for-each walk forms)
  (set! top-level-names
    (let loop ((rest forms) (out '()))
      (if (null? rest) out
          (let ((name (top-level-name (car rest))))
            (loop (cdr rest) (if name (cons name out) out))))))
  (for-each scan-mutations forms))

(define (eval-source source)
  (let ((forms (read-all source)))
    (validate-datums! forms)
    (let loop ((rest forms) (last #f))
      (if (null? rest)
          last
          (loop (cdr rest) (eval (car rest) (interaction-environment)))))))

;; ---------------------------------------------------------------------------
;; Request execution

(define (capture thunk)
  (call/cc
    (lambda (k)
      (with-exception-handler
        (lambda (e) (k (cons 'error e)))
        (lambda () (cons 'ok (thunk)))))))

(define (run-eval id source args)
  (let ((out (capture (lambda ()
                        (let ((value (eval-source source)))
                          (if (procedure? value)
                              (apply value args)
                              value))))))
    (if (eq? (car out) 'ok)
        (let ((value (cdr out)))
          (if (symbol? value)
              (json-error id "SCHEME_QUOTE" "symbol result is not JSON")
              (json-ok id value)))
        (json-error-path id (condition-code (cdr out)) (error-message (cdr out)) "$[2][0]"))))

(define (run-call call)
  (let ((id (car call)) (args (cadr call)))
    (let ((out (capture (lambda ()
                          (let ((proc (lookup-rule id)))
                            (if proc
                                (apply proc args)
                                (raise-rule-error "UNBOUND_RULE" "no such rule")))))))
      (if (eq? (car out) 'ok)
          (string-append "{\"rule\":" (json-value id) ",\"ok\":true,\"value\":"
                         (json-value (cdr out)) "}")
          (string-append "{\"rule\":" (json-value id)
                         ",\"ok\":false,\"error\":{\"code\":\""
                         (json-escape (condition-code (cdr out))) "\",\"message\":\""
                         (json-escape (error-message (cdr out))) "\"}}")))))

(define (run-load id source calls)
  (let ((saved registry)
        (before (sorted-ids)))
    (let ((out (capture (lambda () (eval-source source) (sorted-ids)))))
      (if (eq? (car out) 'ok)
          (let ((ids (cdr out)))
            (string-append "{\"id\":" (json-value id) ",\"ok\":true,\"stateIds\":"
                           (json-array ids) ",\"ids\":" (json-array ids)
                           ",\"calls\":[" (join-json (map run-call calls) ",") "]}"))
          (begin
            (set! registry saved)
            (string-append "{\"id\":" (json-value id) ",\"ok\":false,\"error\":{\"code\":\""
                           (json-escape (condition-code (cdr out))) "\",\"message\":\""
                           (json-escape (error-message (cdr out))) "\"},\"stateIds\":"
                           (json-array before) "}"))))))

(define (main req)
  (let ((op (car req)) (id (cadr req)) (source (caddr req)) (arg (cadddr req)))
    (cond
      ((string=? op "eval") (run-eval id source arg))
      ((string=? op "isolated") (run-eval id source arg))
      ((string=? op "load-module") (run-load id source arg))
      (else (json-error id "UNSUPPORTED" op)))))
